/**
 * Rein — Session-Key Signer Demo (the custody tier)
 *
 * In SDK mode the agent holds its own wallet key: the guard is advisory and a
 * rogue agent is only *detected* (shadow.spend). Here the key moves into
 * @rein/signer and the agent gets a capped, expiring session token. Every
 * EIP-3009 signature requires an engine-signed allow voucher for the exact
 * transfer being signed — verified offline, usable once.
 *
 * Six scenarios, fully offline (every signature cryptographically verified,
 * nothing touches a real chain):
 *   1. Guarded payment — key never enters the agent process
 *   2. Forged voucher — rogue computes every hash right, cannot sign as the engine
 *   3. Inflated requirement — real $0.01 voucher cannot sign a $5.00 transfer
 *   4. Replay — one voucher, one signature
 *   5. Kill switch — freeze now reaches the key itself
 *   6. Session cap — the signer's backstop under policy
 *
 * Run: pnpm --filter @rein/demo demo:signer
 */

import type { AddressInfo } from 'node:net';
import { createHash, generateKeyPairSync, sign as edSign } from 'node:crypto';
import { keccak256, recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import {
  canonicalDecision,
  newId,
  PaymentIntent,
  type Decision,
  type ReinEvent,
} from '@rein/core';
import { PolicyEngine, buildServer } from '@rein/policy-engine';
import {
  createGuard,
  PaymentBlockedError,
  type FetchLike,
  type PaymentRequirement,
} from '@rein/sdk';
import {
  SessionSigner,
  SignerError,
  intentHashOf,
  sessionPayerFor,
} from '@rein/signer';
import {
  BASE_SEPOLIA_USDC,
  decodePaymentHeader,
  transferWithAuthorizationTypes,
} from '@rein/x402-rails';

// ─── config ───────────────────────────────────────────────────────────────────

const VENDOR_TREASURY = '0x1111111111111111111111111111111111111111';
const MULE_ADDRESS = '0x2222222222222222222222222222222222222222';
const VENDOR_HOST = 'api.research.test';
const VENDOR_URL = `https://${VENDOR_HOST}/v1/answer`;
const SESSION_CAP = '0.03'; // cumulative; maxPerPayment left open
const W = 64;

const REQUIREMENT: PaymentRequirement = {
  scheme: 'exact',
  network: 'base-sepolia',
  maxAmountRequired: '10000', // $0.01 USDC at 6 decimals
  resource: VENDOR_URL,
  description: 'research query',
  mimeType: 'application/json',
  payTo: VENDOR_TREASURY,
  maxTimeoutSeconds: 300,
  asset: BASE_SEPOLIA_USDC,
};

// ─── formatting ───────────────────────────────────────────────────────────────

const bar = (c: string) => c.repeat(W);
const section = (label: string) => `\n${bar('─')}\n ${label}\n${bar('─')}`;

function outcome(ok: boolean, label: string, detail: string) {
  const mark = ok ? '✓ SIGNED ' : '✗ REFUSED';
  console.log(`  ${label.padEnd(26)} ${mark}  ${detail}`);
}

function expectRefusal(err: unknown, label: string): SignerError {
  if (!(err instanceof SignerError)) throw err;
  outcome(false, label, `[${err.code}] ${err.message}`);
  return err;
}

// ─── the vendor: pays attention to cryptography, not promises ─────────────────

/**
 * An in-process x402 vendor that only serves content for an EIP-3009 payment
 * whose signature actually recovers to its claimed payer — the same check
 * USDC's contract performs on-chain. Settlement is simulated (no chain).
 */
function evmVendor(): FetchLike {
  return async (input, init) => {
    const payment = init?.headers ? new Headers(init.headers).get('X-PAYMENT') : null;
    if (payment === null) {
      return new Response(
        JSON.stringify({ x402Version: 1, accepts: [REQUIREMENT], error: 'payment required' }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );
    }
    const { payload } = decodePaymentHeader(payment);
    const auth = payload.authorization;
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: BASE_SEPOLIA_USDC },
      types: transferWithAuthorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: auth.from as Hex,
        to: auth.to as Hex,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as Hex,
      },
      signature: payload.signature as Hex,
    });
    if (recovered.toLowerCase() !== auth.from.toLowerCase() || auth.value !== '10000') {
      return new Response(JSON.stringify({ error: 'invalid payment' }), { status: 402 });
    }
    const simulatedTx = keccak256(payload.signature as Hex);
    return new Response(JSON.stringify({ answer: 42 }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'X-PAYMENT-RESPONSE': Buffer.from(
          JSON.stringify({ success: true, transaction: simulatedTx, network: 'base-sepolia' }),
        ).toString('base64'),
      },
    });
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  console.log('\n' + bar('═'));
  console.log('  Rein  ·  Session-Key Signer Demo');
  console.log('  The kill switch becomes a physical fact');
  console.log(bar('═'));

  // ── Setup ──────────────────────────────────────────────────────────────────

  const engine = new PolicyEngine();
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const agentId = newId('agt');
  engine.registerAgent({
    id: agentId,
    orgId: newId('org'),
    name: 'research-agent',
    wallets: [],
    status: 'active',
    createdAt: new Date(),
  });
  engine.addPolicy({
    policyId: 'research-policy',
    appliesTo: { agents: [agentId] },
    rules: [{ id: 'tx-cap', deny: { amountGt: '1.00' } }],
    default: 'allow',
  });

  // The custody move: the wallet key is generated INTO the signer. The agent
  // process never sees it — it gets a session token instead.
  const signer = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });
  const events: ReinEvent[] = [];
  signer.onEvent((e) => events.push(e));
  const walletAddress = signer.registerWallet(agentId, generatePrivateKey());
  const { session, token } = signer.createSession({
    agentId,
    capAmount: SESSION_CAP,
    ttlSeconds: 3600,
  });

  const guard = createGuard({
    engineUrl,
    agentId,
    fetch: evmVendor(),
    payer: sessionPayerFor(signer, token),
  });
  const fetch = guard.wrap();

  console.log(`\n  Agent     ${agentId}  (research-agent)`);
  console.log(`  Wallet    ${walletAddress}  [base-sepolia]`);
  console.log(`            key lives in @rein/signer — never in the agent process`);
  console.log(`  Session   ${session.id}  cap $${SESSION_CAP} · expires in 1h`);
  console.log(`            agent holds: token ${token.slice(0, 8)}…  (that's all it gets)`);
  console.log(`  Engine    ${engineUrl}`);
  console.log(`  Vendor    ${VENDOR_HOST}  ·  $0.01 / call  ·  verifies EIP-3009 signatures`);
  console.log(`\n  Policy "research-policy":  deny if amount > $1.00, else allow`);

  // ── Scenario 1: the happy path ─────────────────────────────────────────────
  console.log(section('Scenario 1  ·  Guarded payment (key never leaves custody)'));

  const res = await fetch(VENDOR_URL);
  const receipt = guard.receipts().at(-1)!;
  outcome(
    true,
    'call 1  $0.01',
    `vendor verified the signature · tx ${receipt.settlement?.txHash?.slice(0, 14)}… (simulated)`,
  );
  console.log(`  HTTP ${res.status} · 402 → evaluate → voucher → sign → paid retry, one fetch call.`);
  console.log(`  Session spent: $${signer.sessionSpent(session.id)} / $${SESSION_CAP}`);

  // ── Scenario 2: forged voucher ─────────────────────────────────────────────
  console.log(section('Scenario 2  ·  Forged voucher (rogue skips the engine)'));
  console.log('  The rogue fabricates a $50 intent to a mule address, computes the');
  console.log('  intentHash and decision hash EXACTLY like the engine — then must sign.\n');

  const rogueIntent = PaymentIntent.parse({
    id: newId('int'),
    agentId,
    vendor: { host: 'mule.test', address: MULE_ADDRESS },
    resource: '/drain',
    amount: '50.00',
    asset: 'USDC',
    chain: 'base',
    taskContext: {},
    nonce: newId('non'),
    createdAt: new Date(),
  });
  const rogueContent = {
    intentId: rogueIntent.id,
    intentHash: intentHashOf(rogueIntent),
    outcome: 'allow' as const,
    matchedRules: [],
    policyId: 'research-policy',
    policyVersion: '1',
    prevHash: 'genesis',
    decidedAt: new Date(),
  };
  const rogueHash = createHash('sha256').update(canonicalDecision(rogueContent)).digest('hex');
  const rogueKeys = generateKeyPairSync('ed25519');
  const forgedDecision: Decision = {
    ...rogueContent,
    id: newId('dec'),
    hash: rogueHash,
    signature: edSign(null, Buffer.from(rogueHash), rogueKeys.privateKey).toString('base64'),
    latencyMs: 0,
  };

  try {
    await signer.sign({
      sessionToken: token,
      requirement: { ...REQUIREMENT, maxAmountRequired: '50000000', payTo: MULE_ADDRESS },
      intent: rogueIntent,
      decision: forgedDecision,
    });
    throw new Error('the forged voucher was signed — this must never happen');
  } catch (e) {
    expectRefusal(e, 'forged $50.00 → mule');
  }
  console.log('\n  Every hash was correct. The ed25519 signature was not the engine\'s.');
  console.log('  Without the engine\'s private key there is no spendable voucher.');

  // ── Scenario 3: inflated requirement ───────────────────────────────────────
  console.log(section('Scenario 3  ·  Real voucher, inflated transfer'));
  console.log('  The rogue gets a REAL allow voucher for $0.01, then asks the signer');
  console.log('  to authorize $5.00 with it.\n');

  const small = engine.evaluateIntent({
    agentId,
    vendor: { host: VENDOR_HOST, address: VENDOR_TREASURY },
    resource: '/v1/answer',
    amount: '0.01',
    asset: 'USDC',
    chain: 'base',
  });
  try {
    await signer.sign({
      sessionToken: token,
      requirement: { ...REQUIREMENT, maxAmountRequired: '5000000' }, // $5.00
      intent: small.intent,
      decision: small.decision,
    });
    throw new Error('an inflated transfer was signed — this must never happen');
  } catch (e) {
    expectRefusal(e, 'voucher $0.01, asks $5.00');
  }
  console.log('\n  The signature commits to amount and recipient; both must equal what');
  console.log('  the engine judged. The voucher is not a blank check.');

  // ── Scenario 4: replay ─────────────────────────────────────────────────────
  console.log(section('Scenario 4  ·  Replay (one voucher, one signature)'));

  const fresh = engine.evaluateIntent({
    agentId,
    vendor: { host: VENDOR_HOST, address: VENDOR_TREASURY },
    resource: '/v1/answer',
    amount: '0.01',
    asset: 'USDC',
    chain: 'base',
  });
  await signer.sign({
    sessionToken: token,
    requirement: REQUIREMENT,
    intent: fresh.intent,
    decision: fresh.decision,
  });
  outcome(true, 'first use  $0.01', 'voucher accepted');
  try {
    await signer.sign({
      sessionToken: token,
      requirement: REQUIREMENT,
      intent: fresh.intent,
      decision: fresh.decision,
    });
    throw new Error('a replayed voucher was signed — this must never happen');
  } catch (e) {
    expectRefusal(e, 'same voucher again');
  }
  console.log(`\n  Session spent: $${signer.sessionSpent(session.id)} / $${SESSION_CAP}`);

  // ── Scenario 5: kill switch ────────────────────────────────────────────────
  console.log(section('Scenario 5  ·  Kill switch (freeze reaches the key)'));

  engine.freeze(agentId);
  console.log(`  >> engine.freeze(${agentId})\n`);

  try {
    await fetch(VENDOR_URL);
    throw new Error('expected PaymentBlockedError but the call succeeded');
  } catch (e) {
    if (!(e instanceof PaymentBlockedError)) throw e;
    outcome(false, 'guarded call  $0.01', `engine: ${e.decision.reason ?? 'denied'}`);
  }

  // The rogue ignores the guard and goes straight to the signer with the
  // deny decision it just received. The signer reads the same outcome.
  const denied = engine.evaluateIntent({
    agentId,
    vendor: { host: VENDOR_HOST, address: VENDOR_TREASURY },
    resource: '/v1/answer',
    amount: '0.01',
    asset: 'USDC',
    chain: 'base',
  });
  try {
    await signer.sign({
      sessionToken: token,
      requirement: REQUIREMENT,
      intent: denied.intent,
      decision: denied.decision,
    });
    throw new Error('a deny decision released a signature — this must never happen');
  } catch (e) {
    expectRefusal(e, 'straight to the signer');
  }
  console.log('\n  In SDK mode a frozen agent could still spend (and be caught later).');
  console.log('  Here there is nothing to spend WITH: no allow, no signature, no payment.');

  engine.unfreeze(agentId);
  console.log(`\n  >> engine.unfreeze(${agentId})  ← released`);

  // ── Scenario 6: session cap ────────────────────────────────────────────────
  console.log(section('Scenario 6  ·  Session cap (the backstop under policy)'));
  console.log(`  Policy allows up to $1.00/tx — but this session has signed $0.02 of`);
  console.log(`  its $${SESSION_CAP} cap. Two more $0.01 calls:\n`);

  await fetch(VENDOR_URL);
  outcome(true, 'call  $0.01', `spent $${signer.sessionSpent(session.id)} / $${SESSION_CAP} — at the cap`);
  try {
    await fetch(VENDOR_URL);
    throw new Error('the session cap was exceeded — this must never happen');
  } catch (e) {
    expectRefusal(e, 'call  $0.01');
  }
  console.log('\n  The engine said allow; the session had no room left. Stolen tokens');
  console.log('  are bounded by their cap and their clock, not by vendor goodwill.');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + bar('═'));
  console.log('  Summary');
  console.log(bar('═'));

  const released = events.filter((e) => e.type === 'signature.released');
  const refused = events.filter((e) => e.type === 'signature.refused');
  const codes = refused
    .map((e) => (e.type === 'signature.refused' ? e.code : ''))
    .join(', ');

  console.log(`
  Signatures released:  ${released.length}  ($${signer.sessionSpent(session.id)} total, all cryptographically verified)
  Signatures refused:   ${refused.length}  (${codes})
  Decision log:         ${engine.decisions().length} entries  (ed25519-signed, sha256-chained, intent-bound)
  Key custody:          signer-only — the agent process never held a private key
  Elapsed:              ${Date.now() - t0}ms
`);

  console.log(bar('═'));
  console.log('  Done.\n');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
