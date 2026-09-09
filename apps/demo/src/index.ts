/**
 * Rein v0.1 — End-to-End Demo
 *
 * Seven scenarios in one in-process run (<1s):
 *   1. Normal calls allowed within rolling budget
 *   2. Rolling-budget cap enforcement (deny before payment exists)
 *   3. Single-transaction cap
 *   4. Kill switch — engine.freeze() / engine.unfreeze()
 *   5. Shadow spend — direct ledger.transfer() flagged by the indexer
 *   6. Behavioral breaker: trips, escalates, cleared by a SIGNED approval
 *   7. Per-task budget: a runaway task escalates while other tasks run on
 *
 * Run: pnpm --filter @reinconsole/demo demo
 */

import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { newId } from '@reinconsole/core';
import {
  ApprovalService,
  PolicyEngine,
  buildServer,
  signApproval,
} from '@reinconsole/policy-engine';
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { MockLedger, MockFacilitator, MockIndexer, createMockVendor } from '@reinconsole/mock-rails';

// ─── config ───────────────────────────────────────────────────────────────────

const WALLET = '0xResearch01';
const BUDGET_CAP = '0.04';  // rolling $0.04/hr
const TX_CAP = '0.50';      // max $0.50 per transaction
const VENDOR_URL = 'https://api.data.test/v1/query';
const W = 64;

// ─── formatting ───────────────────────────────────────────────────────────────

const bar = (c: string) => c.repeat(W);
const usd = (a: string | number) => `$${Number(a).toFixed(2)}`;
const section = (label: string) =>
  `\n${bar('─')}\n ${label}\n${bar('─')}`;

function outcome(result: 'allow' | 'deny', label: string, detail: string) {
  const mark = result === 'allow' ? '✓ ALLOW' : '✗ DENY ';
  console.log(`  ${label.padEnd(24)} ${mark}  ${detail}`);
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  console.log('\n' + bar('═'));
  console.log('  Rein v0.1  ·  End-to-End Demo');
  console.log('  The control plane for AI agent payments');
  console.log(bar('═'));

  // ── Setup ──────────────────────────────────────────────────────────────────

  // Real policy engine over HTTP on an ephemeral port (same as tests)
  // An approval tier makes `escalate` answerable: without one it is a hard
  // block, and scenarios 6-7 would have nowhere to go.
  const approvals = new ApprovalService();
  const engine = new PolicyEngine({ approvals });
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const engineUrl = `http://127.0.0.1:${port}`;

  // Mock rails: ledger (the chain), facilitator (x402 settler), indexer
  const ledger = new MockLedger();
  const facilitator = new MockFacilitator({ ledger, name: 'mock-facilitator' });
  const indexer = new MockIndexer({
    ledger,
    agents: () => engine.agents.list(),
    facilitator: facilitator.name,
  });
  indexer.connectEngine(engine);

  // Paywalled in-process vendor: $0.01 per request (10000 atomic USDC, 6 dec)
  const vendor = createMockVendor({
    facilitator,
    atomicPrice: '10000',
    payTo: '0xVendorTreasury',
  });

  // Register the research agent and install policy
  const agentId = newId('agt');
  await engine.registerAgent({
    id: agentId,
    orgId: newId('org'),
    name: 'research-agent',
    wallets: [{ chain: 'base', address: WALLET, mode: 'sdk' }],
    status: 'active',
    createdAt: new Date(),
  });

  const guard = createGuard({
    engineUrl,
    agentId,
    fetch: vendor.fetch,
    payer: facilitator.payerFor(WALLET),
  });

  await guard.client.addPolicy({
    policyId: 'research-policy',
    appliesTo: { agents: [agentId] },
    rules: [
      { id: 'tx-cap', deny: { amountGt: TX_CAP } },
      { id: 'hour-budget', deny: { rollingSum: { window: '1h', gt: BUDGET_CAP } } },
    ],
    default: 'allow',
  });

  console.log(`\n  Agent     ${agentId}  (research-agent)`);
  console.log(`  Wallet    ${WALLET}  [base · sdk mode]`);
  console.log(`  Engine    ${engineUrl}`);
  console.log(`  Vendor    api.data.test  ·  $0.01 / call`);
  console.log(`\n  Policy "research-policy":`);
  console.log(`    Rule  tx-cap        deny if amount > $${TX_CAP}`);
  console.log(`    Rule  hour-budget   deny if rolling spend (1h) would exceed $${BUDGET_CAP}`);
  console.log(`    Default             allow`);

  const fetch = guard.wrap();

  // ── Scenario 1: Normal calls ───────────────────────────────────────────────
  console.log(section('Scenario 1  ·  Normal calls (within budget)'));

  for (let i = 1; i <= 4; i++) {
    await fetch(VENDOR_URL);
    const r = guard.receipts().at(-1)!;
    const spent = (i * 0.01).toFixed(2);
    const tx = r.settlement?.txHash?.slice(0, 12) ?? '—';
    outcome('allow', `call ${i}  $0.01`, `budget: $${spent}/$${BUDGET_CAP}  tx: ${tx}…`);
  }

  // ── Scenario 2: Budget exhausted ──────────────────────────────────────────
  console.log(section('Scenario 2  ·  Rolling-budget enforcement'));
  console.log('  Agent has spent $0.04 this hour. A 5th $0.01 call would push to $0.05.\n');

  try {
    await fetch(VENDOR_URL);
    throw new Error('expected PaymentBlockedError but call succeeded');
  } catch (e) {
    if (!(e instanceof PaymentBlockedError)) throw e;
    outcome('deny', 'call 5  $0.01', e.decision.reason ?? 'blocked');
    console.log(`\n  No ledger entry added — payment was never constructed.`);
    console.log(`  Ledger: ${ledger.entries().length} entries (all from the 4 allowed calls above).`);
  }

  // ── Scenario 3: TX cap ────────────────────────────────────────────────────
  console.log(section('Scenario 3  ·  Single-transaction cap'));
  console.log(`  A premium vendor quotes $5.00 — over the $0.50 tx cap, and over what's left`);
  console.log(`  of the hour budget too, so the deny below names both rules.\n`);

  // Create a separate vendor at $5.00 per call and wire a new guard for it
  // (same agent + same policy — the tx-cap rule applies regardless of vendor)
  const premiumVendor = createMockVendor({
    facilitator,
    atomicPrice: '5000000',   // $5.00 USDC (6 decimals)
    payTo: '0xPremiumVendor',
  });
  const premiumGuard = createGuard({
    engineUrl,
    agentId,
    fetch: premiumVendor.fetch,
    payer: facilitator.payerFor(WALLET),
  });

  try {
    await premiumGuard.wrap()('https://api.data.test/v1/premium');
    throw new Error('expected PaymentBlockedError but call succeeded');
  } catch (e) {
    if (!(e instanceof PaymentBlockedError)) throw e;
    outcome('deny', 'call  $5.00', e.decision.reason ?? 'blocked');
    console.log(`\n  No ledger entry — payment blocked before X-PAYMENT was constructed.`);
    console.log(`  Ledger: ${ledger.entries().length} entries (unchanged).`);
  }

  // ── Scenario 4: Kill switch ────────────────────────────────────────────────
  console.log(section('Scenario 4  ·  Kill switch (agent freeze)'));
  console.log(`  A second agent (ks-agent) with its own allow-all policy — fresh, so the`);
  console.log(`  freeze/unfreeze story isn't tangled in research-agent's exhausted budget.\n`);

  // Register a fresh agent so the kill-switch demo is isolated from budget state
  const ksWallet = '0xKillSwitch01';
  const ksAgentId = newId('agt');
  await engine.registerAgent({
    id: ksAgentId,
    orgId: newId('org'),
    name: 'ks-agent',
    wallets: [{ chain: 'base', address: ksWallet, mode: 'sdk' }],
    status: 'active',
    createdAt: new Date(),
  });
  const ksGuard = createGuard({
    engineUrl,
    agentId: ksAgentId,
    fetch: vendor.fetch,
    payer: facilitator.payerFor(ksWallet),
  });
  await ksGuard.client.addPolicy({
    policyId: 'ks-policy',
    appliesTo: { agents: [ksAgentId] },
    default: 'allow',
  });
  const ksFetch = ksGuard.wrap();

  // Normal call before freeze
  await ksFetch(VENDOR_URL);
  outcome('allow', 'call (pre-freeze)  $0.01', 'no rules — policy default allow');

  // Freeze the agent
  await engine.freeze(ksAgentId);
  console.log(`\n  >> engine.freeze(${ksAgentId})  ← kill switch engaged`);

  try {
    await ksFetch(VENDOR_URL);
    throw new Error('expected PaymentBlockedError but call succeeded');
  } catch (e) {
    if (!(e instanceof PaymentBlockedError)) throw e;
    outcome('deny', 'call (frozen)  $0.01', e.decision.reason ?? 'blocked');
  }

  // Unfreeze and confirm recovery
  await engine.unfreeze(ksAgentId);
  console.log(`  >> engine.unfreeze(${ksAgentId})  ← kill switch released`);
  await ksFetch(VENDOR_URL);
  outcome('allow', 'call (post-unfreeze)  $0.01', 'kill switch released — calls resume');

  // ── Scenario 5: Shadow spend ───────────────────────────────────────────────
  console.log(section('Scenario 5  ·  Shadow spend (bypass detection)'));
  console.log(
    '  The research-agent calls ledger.transfer() directly — no guard, no policy check.',
  );
  console.log('  The indexer watches every transfer from a managed wallet.\n');

  const entry = ledger.transfer({
    chain: 'base',
    asset: 'USDC',
    from: WALLET,
    to: '0xDeadVendor',
    amount: '2.50',
  });

  const shadow = indexer.shadowSpends().at(-1);
  console.log(`  Transfer:  $2.50 USDC  ${WALLET} → 0xDeadVendor`);
  console.log(`  txHash:    ${entry.txHash.slice(0, 20)}…`);
  console.log(`\n  Indexer:   [SHADOW SPEND] flagged`);
  if (shadow) {
    console.log(`    agentId:  ${shadow.agentId}`);
    console.log(`    chain:    ${shadow.chain}`);
    console.log(`    amount:   ${usd(shadow.amount)}`);
    console.log(`    txHash:   ${shadow.txHash.slice(0, 20)}…`);
  }

  // -- Scenario 6: Behavioral breaker ----------------------------------------
  console.log(section('Scenario 6  ·  Behavioral breaker + signed approval'));
  console.log('  A breaker watches BEHAVIOR, not one payment: 3 calls an hour is the');
  console.log('  envelope. The 4th does not get denied — a silent deny would strand a');
  console.log('  running job. It ESCALATES, and only an ed25519 signature releases it.\n');

  // The approver's key pair. In production the private half never comes near
  // the engine — it lives on a hardware token or a laptop. Here it stands in
  // for the human, so the demo can produce a real signature.
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const approver = await approvals.registerApprover({
    orgId: newId('org'),
    name: 'Finance (demo key)',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });

  const brWallet = '0xBreaker01';
  const brAgentId = newId('agt');
  await engine.registerAgent({
    id: brAgentId,
    orgId: newId('org'),
    name: 'breaker-agent',
    wallets: [{ chain: 'base', address: brWallet, mode: 'sdk' }],
    status: 'active',
    createdAt: new Date(),
  });
  const brGuard = createGuard({
    engineUrl,
    agentId: brAgentId,
    fetch: vendor.fetch,
    payer: facilitator.payerFor(brWallet),
  });
  await brGuard.client.addPolicy({
    policyId: 'breaker-policy',
    appliesTo: { agents: [brAgentId] },
    breakers: [{ id: 'velocity', window: '1h', txCount: 3 }],
    default: 'allow',
  });
  const brFetch = brGuard.wrap();

  for (let i = 1; i <= 3; i++) {
    await brFetch(VENDOR_URL);
    outcome('allow', `call ${i}  $0.01`, `inside the envelope (${i}/3 in 1h)`);
  }

  let parked;
  try {
    await brFetch(VENDOR_URL);
    throw new Error('expected PaymentBlockedError but call succeeded');
  } catch (e) {
    if (!(e instanceof PaymentBlockedError)) throw e;
    parked = e.approval;
    console.log(`  ${'call 4  $0.01'.padEnd(24)} ⏸ HOLD   ${e.decision.reason ?? 'escalated'}`);
  }
  if (!parked) throw new Error('expected a parked approval request');

  console.log(`\n  Parked:    decision ${parked.decisionId}`);
  console.log(`             breakers ${parked.breakers.join(', ')}  ·  expires ${parked.expiresAt.toISOString()}`);
  console.log('  A channel (Telegram, email) would carry these bytes to a human. The');
  console.log('  channel is transport — it is never asked to assert a verdict.\n');

  const resolved = await engine.resolveEscalation({
    decisionId: parked.decisionId,
    intentHash: parked.intentHash,
    verdict: 'approve',
    approverKeyId: approver.id,
    signature: signApproval(privateKey, {
      decisionId: parked.decisionId,
      intentHash: parked.intentHash,
      verdict: 'approve',
    }),
  });
  console.log(`  >> signed approve by ${approver.name}`);
  console.log('  The escalate decision is NOT rewritten. A second decision is APPENDED');
  console.log('  for the same intent, and that one is the voucher a signer verifies:');
  console.log(`    ${parked.decisionId}  escalate  (unchanged, still on the chain)`);
  console.log(`    ${resolved.decision.id}  ${resolved.decision.outcome}     <- ${resolved.decision.reason}`);

  // The blocked call itself is not replayed here: the SDK raised, so the
  // caller retries (or runs with `escalation: { await: true }` and simply
  // waits for the signature). What the approval changed is the ENVELOPE.
  const [brState] = await brGuard.client.breakerStates(brAgentId);
  console.log(`\n  Breaker "velocity" after the approval:  tripped=${brState?.tripped}  (${brState?.txCount} tx counted)`);
  await brFetch(VENDOR_URL);
  outcome('allow', 'call 5  $0.01', 'breaker cleared — the agent runs on');

  // -- Scenario 7: Per-task budget -------------------------------------------
  console.log(section('Scenario 7  ·  Per-task budget'));
  console.log('  A budget scoped to one unit of work, not to a window: the research run');
  console.log('  meant to cost $0.03 cannot quietly cost $0.30, however slowly it does it.');
  console.log('  Other tasks by the same agent are untouched.\n');

  const tbWallet = '0xTaskBudget01';
  const tbAgentId = newId('agt');
  await engine.registerAgent({
    id: tbAgentId,
    orgId: newId('org'),
    name: 'task-agent',
    wallets: [{ chain: 'base', address: tbWallet, mode: 'sdk' }],
    status: 'active',
    createdAt: new Date(),
  });
  const tbGuard = createGuard({
    engineUrl,
    agentId: tbAgentId,
    fetch: vendor.fetch,
    payer: facilitator.payerFor(tbWallet),
  });
  await tbGuard.client.addPolicy({
    policyId: 'task-policy',
    appliesTo: { agents: [tbAgentId] },
    rules: [{ id: 'task-cap', escalate: { taskBudget: { gt: '0.03' } } }],
    default: 'allow',
  });

  // withTask carries the attribution on every intent submitted inside it —
  // the guard reads it from async local storage, so nothing in the calling
  // code has to thread a task id through the fetch.
  const tbFetch = tbGuard.wrap();

  await tbGuard.withTask({ taskId: 'run-A', purpose: 'market scan' }, async () => {
    for (let i = 1; i <= 3; i++) {
      await tbFetch(VENDOR_URL);
      outcome('allow', `run-A call ${i}  $0.01`, `task spend: ${usd((i * 0.01).toFixed(2))}/$0.03`);
    }
    try {
      await tbFetch(VENDOR_URL);
      throw new Error('expected PaymentBlockedError but call succeeded');
    } catch (e) {
      if (!(e instanceof PaymentBlockedError)) throw e;
      console.log(`  ${'run-A call 4  $0.01'.padEnd(24)} HOLD    ${e.decision.reason ?? 'escalated'}`);
    }
  });

  await tbGuard.withTask({ taskId: 'run-B', purpose: 'competitor scan' }, async () => {
    await tbFetch(VENDOR_URL);
    outcome('allow', 'run-B call 1  $0.01', 'a different task, its own budget');
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + bar('═'));
  console.log('  Summary');
  console.log(bar('═'));

  const allReceipts = [
    ...guard.receipts(),         // research-agent: 4 allow + 1 deny
    ...premiumGuard.receipts(),  // premium call:   1 deny
    ...ksGuard.receipts(),       // ks-agent:       2 allow + 1 deny
    ...brGuard.receipts(),       // breaker-agent:  4 allow + 1 escalate
    ...tbGuard.receipts(),       // task-agent:     4 allow + 1 escalate
  ];
  const allowed = allReceipts.filter((r) => r.outcome === 'allow');
  const denied = allReceipts.filter((r) => r.outcome !== 'allow');

  console.log(`
  Receipts:          ${allReceipts.length}  (${allowed.length} allowed, ${denied.length} denied)
  Ledger entries:    ${ledger.entries().length}  (${allowed.length} from allowed calls + 1 shadow)
  Settled payments:  ${indexer.settledPayments().length}
  Shadow spends:     ${indexer.shadowSpends().length}
  Escalations:       ${approvals.list().length}  (${approvals.pending().length} still parked)
  Decision log:      ${engine.decisions().length} entries  (ed25519-signed, sha256-chained)
  Elapsed:           ${Date.now() - t0}ms
`);

  console.log('  All receipts:');
  for (const r of allReceipts) {
    const mark = r.outcome === 'allow' ? 'ALLOW' : 'DENY ';
    const tx = r.settlement?.txHash ? `  tx: ${r.settlement.txHash.slice(0, 14)}…` : '';
    const why = r.reason ? `  (${r.reason})` : '';
    console.log(`    [${mark}]  ${usd(r.amount).padEnd(6)}  ${r.vendorHost.padEnd(18)}${tx}${why}`);
  }

  console.log('\n' + bar('═'));
  console.log('  Done.\n');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
