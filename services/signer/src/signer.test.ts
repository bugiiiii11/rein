import { describe, it, expect } from 'vitest';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { newId, type ReinEvent } from '@rein/core';
import {
  BASE_SEPOLIA_USDC,
  decodePaymentHeader,
  intentNonce,
  transferWithAuthorizationTypes,
} from '@rein/x402-rails';
import { SessionSigner } from './signer.js';
import { SignerError } from './errors.js';
import type { CreateSessionInput } from './sessions.js';
import { evaluateFor, makeEngine, makeRequirement, VENDOR_ADDRESS } from './testkit.js';

/** Engine + signer + custodied wallet + session, with a controllable clock. */
async function makeWorld(sessionInput: Partial<CreateSessionInput> = {}) {
  const { engine, agentId } = await makeEngine();
  const clock = { nowMs: Date.now() };
  const signer = new SessionSigner({
    enginePublicKeyPem: engine.publicKeyPem,
    now: () => clock.nowMs,
  });
  const events: ReinEvent[] = [];
  signer.onEvent((e) => events.push(e));
  const privateKey = generatePrivateKey();
  const walletAddress = signer.registerWallet(agentId, privateKey);
  const { session, token } = await signer.createSession({ agentId, ...sessionInput });
  return { engine, agentId, signer, clock, events, walletAddress, session, token };
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<SignerError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SignerError);
    expect((err as SignerError).code).toBe(code);
    return err as SignerError;
  }
  throw new Error(`expected a ${code} refusal, but the signer signed`);
}

describe('SessionSigner', () => {
  it('releases a valid EIP-3009 signature for a genuine allow voucher', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    const requirement = makeRequirement();

    const result = await w.signer.sign({ sessionToken: w.token, requirement, intent, decision });

    expect(result.from).toBe(w.walletAddress);
    const payload = decodePaymentHeader(result.paymentHeader);
    expect(payload.payload.authorization.to).toBe(VENDOR_ADDRESS);
    expect(payload.payload.authorization.value).toBe('10000');
    expect(payload.payload.authorization.nonce).toBe(intentNonce(intent.id));

    // The signature really spends from the custodied wallet.
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: BASE_SEPOLIA_USDC },
      types: transferWithAuthorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: payload.payload.authorization.from as `0x${string}`,
        to: payload.payload.authorization.to as `0x${string}`,
        value: BigInt(payload.payload.authorization.value),
        validAfter: BigInt(payload.payload.authorization.validAfter),
        validBefore: BigInt(payload.payload.authorization.validBefore),
        nonce: payload.payload.authorization.nonce as `0x${string}`,
      },
      signature: payload.payload.signature as `0x${string}`,
    });
    expect(recovered).toBe(w.walletAddress);

    expect(w.signer.sessionSpent(w.session.id)).toBe('0.01');
    const released = w.events.filter((e) => e.type === 'signature.released');
    expect(released).toHaveLength(1);
  });

  it('refuses an unknown session token', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    await expectRefusal(
      w.signer.sign({ sessionToken: 'not-a-token', requirement: makeRequirement(), intent, decision }),
      'session_unknown',
    );
  });

  it('refuses an expired session', async () => {
    const w = await makeWorld({ ttlSeconds: 10 });
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    w.clock.nowMs += 11_000;
    await expectRefusal(
      w.signer.sign({ sessionToken: w.token, requirement: makeRequirement(), intent, decision }),
      'session_expired',
    );
  });

  it('refuses a revoked session', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    await w.signer.revokeSession(w.session.id);
    await expectRefusal(
      w.signer.sign({ sessionToken: w.token, requirement: makeRequirement(), intent, decision }),
      'session_revoked',
    );
  });

  it("refuses another agent's intent on this session", async () => {
    const w = await makeWorld();
    const other = await w.engine.registerAgent({
      id: newId('agt'),
      orgId: newId('org'),
      name: 'other',
      wallets: [],
      status: 'active',
      createdAt: new Date(),
    });
    const { intent, decision } = await evaluateFor(w.engine, other.id);
    await expectRefusal(
      w.signer.sign({ sessionToken: w.token, requirement: makeRequirement(), intent, decision }),
      'agent_mismatch',
    );
  });

  it('refuses when no wallet is in custody for the agent', async () => {
    const { engine, agentId } = await makeEngine();
    const signer = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });
    const { token } = await signer.createSession({ agentId });
    const { intent, decision } = await evaluateFor(engine, agentId);
    await expectRefusal(
      signer.sign({ sessionToken: token, requirement: makeRequirement(), intent, decision }),
      'no_wallet',
    );
  });

  it('refuses a forged voucher (intent inflated after the decision)', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    const forged = { ...intent, amount: '100.00' };
    await expectRefusal(
      w.signer.sign({
        sessionToken: w.token,
        requirement: makeRequirement({ maxAmountRequired: '100000000' }),
        intent: forged,
        decision,
      }),
      'voucher_invalid',
    );
  });

  it('refuses a deny decision — the kill switch reaches the key', async () => {
    const w = await makeWorld();
    await w.engine.freeze(w.agentId);
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    expect(decision.outcome).toBe('deny');
    const err = await expectRefusal(
      w.signer.sign({ sessionToken: w.token, requirement: makeRequirement(), intent, decision }),
      'not_allowed',
    );
    expect(err.message).toMatch(/frozen/);
  });

  it('refuses a stale decision', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    w.clock.nowMs += 301_000;
    await expectRefusal(
      w.signer.sign({ sessionToken: w.token, requirement: makeRequirement(), intent, decision }),
      'decision_stale',
    );
  });

  it('refuses to use a decision twice', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    await w.signer.sign({ sessionToken: w.token, requirement: makeRequirement(), intent, decision });
    await expectRefusal(
      w.signer.sign({ sessionToken: w.token, requirement: makeRequirement(), intent, decision }),
      'decision_replayed',
    );
  });

  it('lets exactly one of two concurrent requests spend the same voucher', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    const attempt = () =>
      w.signer
        .sign({ sessionToken: w.token, requirement: makeRequirement(), intent, decision })
        .then(() => 'signed' as const)
        .catch((err: SignerError) => err.code);
    const results = await Promise.all([attempt(), attempt()]);
    expect(results.filter((r) => r === 'signed')).toHaveLength(1);
    expect(results.filter((r) => r === 'decision_replayed')).toHaveLength(1);
    expect(w.signer.sessionSpent(w.session.id)).toBe('0.01');
  });

  it('lets exactly one of two concurrent signs fit under the session cap', async () => {
    // Two DISTINCT vouchers, each individually fine, but only one fits the
    // cap. Without serialization both pass the cap check before either
    // records its spend — the last-line backstop would leak.
    const w = await makeWorld({ capAmount: '0.015' });
    const a = await evaluateFor(w.engine, w.agentId);
    const b = await evaluateFor(w.engine, w.agentId);
    const attempt = (v: typeof a) =>
      w.signer
        .sign({ sessionToken: w.token, requirement: makeRequirement(), ...v })
        .then(() => 'signed' as const)
        .catch((err: SignerError) => err.code);
    const results = await Promise.all([attempt(a), attempt(b)]);
    expect(results.filter((r) => r === 'signed')).toHaveLength(1);
    expect(results.filter((r) => r === 'session_cap_exceeded')).toHaveLength(1);
    expect(w.signer.sessionSpent(w.session.id)).toBe('0.01');
  });

  it('refuses a requirement inflated beyond what the decision authorized', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    const err = await expectRefusal(
      w.signer.sign({
        sessionToken: w.token,
        requirement: makeRequirement({ maxAmountRequired: '5000000' }), // 5.00, decision said 0.01
        intent,
        decision,
      }),
      'requirement_mismatch',
    );
    expect(err.message).toMatch(/asks 5/);
  });

  it('refuses a requirement paying a different recipient', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    await expectRefusal(
      w.signer.sign({
        sessionToken: w.token,
        requirement: makeRequirement({ payTo: '0x3333333333333333333333333333333333333333' }),
        intent,
        decision,
      }),
      'requirement_mismatch',
    );
  });

  it('refuses a requirement on an unresolvable asset', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    await expectRefusal(
      w.signer.sign({
        sessionToken: w.token,
        requirement: makeRequirement({ asset: '0x4444444444444444444444444444444444444444' }),
        intent,
        decision,
      }),
      'requirement_mismatch',
    );
  });

  it('refuses a network these rails cannot sign for', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId, { chain: 'polygon' });
    await expectRefusal(
      w.signer.sign({
        sessionToken: w.token,
        requirement: makeRequirement({ network: 'polygon-amoy' }),
        intent,
        decision,
      }),
      'unsupported_network',
    );
  });

  it('enforces the per-payment cap under an allow decision', async () => {
    const w = await makeWorld({ maxPerPayment: '0.005' });
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    expect(decision.outcome).toBe('allow'); // policy is fine with 0.01; the session is not
    await expectRefusal(
      w.signer.sign({ sessionToken: w.token, requirement: makeRequirement(), intent, decision }),
      'per_payment_cap_exceeded',
    );
  });

  it('enforces the cumulative session cap across payments', async () => {
    const w = await makeWorld({ capAmount: '0.02' });
    const requirement = makeRequirement();
    for (let i = 0; i < 2; i++) {
      const { intent, decision } = await evaluateFor(w.engine, w.agentId);
      await w.signer.sign({ sessionToken: w.token, requirement, intent, decision });
    }
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    await expectRefusal(
      w.signer.sign({ sessionToken: w.token, requirement, intent, decision }),
      'session_cap_exceeded',
    );
    expect(w.signer.sessionSpent(w.session.id)).toBe('0.02');
  });

  it('emits signature.refused with the code for every refusal', async () => {
    const w = await makeWorld();
    const { intent, decision } = await evaluateFor(w.engine, w.agentId);
    await expectRefusal(
      w.signer.sign({ sessionToken: 'wrong', requirement: makeRequirement(), intent, decision }),
      'session_unknown',
    );
    const refused = w.events.filter((e) => e.type === 'signature.refused');
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ code: 'session_unknown', intentId: intent.id });
  });
});

describe('SessionSigner.registerWallet', () => {
  it('returns the wallet address derived from the key', async () => {
    const { engine, agentId } = await makeEngine();
    const signer = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });
    const privateKey = generatePrivateKey();
    const address = signer.registerWallet(agentId, privateKey);
    expect(address).toBe(privateKeyToAccount(privateKey).address);
    expect(signer.walletAddress(agentId)).toBe(address);
  });
});
