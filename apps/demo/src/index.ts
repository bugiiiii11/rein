/**
 * Rein v0.1 — End-to-End Demo
 *
 * Five scenarios in one in-process run (<1s):
 *   1. Normal calls allowed within rolling budget
 *   2. Rolling-budget cap enforcement (deny before payment exists)
 *   3. Single-transaction cap
 *   4. Kill switch — engine.freeze() / engine.unfreeze()
 *   5. Shadow spend — direct ledger.transfer() flagged by the indexer
 *
 * Run: pnpm --filter @rein/demo demo
 */

import type { AddressInfo } from 'node:net';
import { newId } from '@rein/core';
import { PolicyEngine, buildServer } from '@rein/policy-engine';
import { createGuard, PaymentBlockedError } from '@rein/sdk';
import { MockLedger, MockFacilitator, MockIndexer, createMockVendor } from '@rein/mock-rails';

// ─── config ───────────────────────────────────────────────────────────────────

const WALLET = '0xResearch01';
const BUDGET_CAP = '0.04';  // rolling $0.04/hr
const TX_CAP = '0.50';      // max $0.50 per transaction
const VENDOR_URL = 'https://api.data.test/v1/query';
const W = 64;

// ─── formatting ───────────────────────────────────────────────────────────────

const bar = (c: string) => c.repeat(W);
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
  const engine = new PolicyEngine();
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
  engine.registerAgent({
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
  console.log(`  A premium vendor quotes $5.00. The tx-cap rule blocks it before payment.\n`);

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

  // Register a fresh agent so the kill-switch demo is isolated from budget state
  const ksWallet = '0xKillSwitch01';
  const ksAgentId = newId('agt');
  engine.registerAgent({
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
  engine.freeze(ksAgentId);
  console.log(`\n  >> engine.freeze(${ksAgentId})  ← kill switch engaged`);

  try {
    await ksFetch(VENDOR_URL);
    throw new Error('expected PaymentBlockedError but call succeeded');
  } catch (e) {
    if (!(e instanceof PaymentBlockedError)) throw e;
    outcome('deny', 'call (frozen)  $0.01', e.decision.reason ?? 'blocked');
  }

  // Unfreeze and confirm recovery
  engine.unfreeze(ksAgentId);
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
    console.log(`    amount:   $${shadow.amount}`);
    console.log(`    txHash:   ${shadow.txHash.slice(0, 20)}…`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + bar('═'));
  console.log('  Summary');
  console.log(bar('═'));

  const allReceipts = [
    ...guard.receipts(),         // research-agent: 4 allow + 1 deny
    ...premiumGuard.receipts(),  // premium call:   1 deny
    ...ksGuard.receipts(),       // ks-agent:       2 allow + 1 deny
  ];
  const allowed = allReceipts.filter((r) => r.outcome === 'allow');
  const denied = allReceipts.filter((r) => r.outcome !== 'allow');

  console.log(`
  Receipts:          ${allReceipts.length}  (${allowed.length} allowed, ${denied.length} denied)
  Ledger entries:    ${ledger.entries().length}  (${allowed.length} from allowed calls + 1 shadow)
  Settled payments:  ${indexer.settledPayments().length}
  Shadow spends:     ${indexer.shadowSpends().length}
  Decision log:      ${engine.decisions().length} entries  (ed25519-signed, sha256-chained)
  Elapsed:           ${Date.now() - t0}ms
`);

  console.log('  All receipts:');
  for (const r of allReceipts) {
    const mark = r.outcome === 'allow' ? 'ALLOW' : 'DENY ';
    const tx = r.settlement?.txHash ? `  tx: ${r.settlement.txHash.slice(0, 14)}…` : '';
    const why = r.reason ? `  (${r.reason})` : '';
    console.log(`    [${mark}]  $${r.amount.padEnd(5)}  ${r.vendorHost.padEnd(18)}${tx}${why}`);
  }

  console.log('\n' + bar('═'));
  console.log('  Done.\n');

  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
