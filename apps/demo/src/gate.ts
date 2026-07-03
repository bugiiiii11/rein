/**
 * Rein — Gate Demo (Phase 2: the vendor side of the wire)
 *
 * So far Rein has governed the agent's side: Guard decides, signer signs.
 * @reinconsole/gate is the SUPPLY side — middleware a vendor drops in front of any
 * Node HTTP API to monetize it over x402: price routes, quote 402s, screen
 * payers, verify + settle payments, and keep receipts so revenue is
 * observable, not anecdotal.
 *
 * Six scenarios, fully offline (mock rails as the chain, but the vendor and
 * the policy engine run over REAL local HTTP):
 *   1. The unpaid crawler — priced route quotes a 402, free route passes
 *   2. Guarded purchase — Rein on BOTH sides: agent receipt, gate receipt,
 *      ledger memo, indexer reconciliation, all for one payment
 *   3. Underpayment — pays $0.005 against a $0.05 quote
 *   4. Replay — the same settled payment, presented again
 *   5. Blocked payer — a denylisted wallet with a perfectly-formed payment
 *   6. Premium pricing + the revenue report
 *
 * Run: pnpm --filter @reinconsole/demo demo:gate
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { newId, type ReinEvent } from '@reinconsole/core';
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import { MockFacilitator, MockIndexer, MockLedger } from '@reinconsole/mock-rails';
import { createGuard, PaymentRequired, type Payer } from '@reinconsole/sdk';
import { createGate, gateMiddleware, mockFacilitatorRails, type Gate } from '@reinconsole/gate';

// ─── config ───────────────────────────────────────────────────────────────────

const VENDOR_TREASURY = '0xVendorTreasury0000000000000000000000001';
const AGENT_WALLET = '0xAgentWallet0000000000000000000000000001';
const MULE_WALLET = '0xMuleWallet00000000000000000000000000666';
const W = 64;

// ─── formatting ───────────────────────────────────────────────────────────────

const bar = (c: string) => c.repeat(W);
const section = (label: string) => `\n${bar('─')}\n ${label}\n${bar('─')}`;

/** Display-only: core normalizes "0.30" to "0.3"; money reads better padded. */
const usd = (decimal: string) => {
  const [int, frac = ''] = decimal.split('.');
  return `$${int}.${frac.padEnd(2, '0')}`;
};

function outcome(ok: boolean, label: string, detail: string) {
  const mark = ok ? '✓ SERVED ' : '✗ REFUSED';
  console.log(`  ${label.padEnd(26)} ${mark}  ${detail}`);
}

/** A handcrafted mock-rails payment header (what a rogue client would forge). */
function craftPayment(from: string, value: string) {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from, to: VENDOR_TREASURY, value, asset: 'USDC' },
    }),
  ).toString('base64');
}

// ─── the vendor: any Node API, gate middleware in front ───────────────────────

async function startVendor(gate: Gate) {
  const paywall = gateMiddleware(gate);
  const server = http.createServer((req, res) => {
    paywall(req, res, () => {
      const path = new URL(req.url ?? '/', 'http://vendor').pathname;
      const body =
        path === '/health'
          ? { status: 'ok' }
          : path === '/api/answer'
            ? { answer: 42 }
            : { forecast: 'sunny, 24°C' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  console.log('\n' + bar('═'));
  console.log('  Rein  ·  Gate Demo');
  console.log('  Phase 2: the vendor side of the wire');
  console.log(bar('═'));

  // ── Setup ──────────────────────────────────────────────────────────────────

  const engine = new PolicyEngine();
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const ledger = new MockLedger();
  const facilitator = new MockFacilitator({ ledger });
  const indexer = new MockIndexer({
    ledger,
    agents: () => engine.agents.list(),
    facilitator: facilitator.name,
  });
  indexer.connectEngine(engine);

  const gateEvents: ReinEvent[] = [];
  const gate = createGate({
    routes: [
      { path: '/api/answer', price: '0.05', description: 'one research answer' },
      { path: '/api/premium/*', method: 'POST', price: '0.25', description: 'premium forecast' },
    ],
    rails: mockFacilitatorRails(facilitator),
    payTo: VENDOR_TREASURY,
    network: 'base',
    asset: 'USDC',
    screen: { denyPayers: [MULE_WALLET] },
  });
  gate.onEvent((e) => gateEvents.push(e));
  const lastRefusal = () => {
    const e = gateEvents.at(-1);
    return e?.type === 'gate.refused' ? `[${e.code}] ${e.reason}` : '(no refusal event?)';
  };

  const vendor = await startVendor(gate);

  const agentId = newId('agt');
  await engine.registerAgent({
    id: agentId,
    orgId: newId('org'),
    name: 'research-agent',
    wallets: [{ chain: 'base', address: AGENT_WALLET, mode: 'sdk' }],
    status: 'active',
    createdAt: new Date(),
  });
  await engine.addPolicy({
    policyId: 'research-policy',
    appliesTo: { agents: [agentId] },
    rules: [{ id: 'tx-cap', deny: { amountGt: '1.00' } }],
    default: 'allow',
  });

  // Capture the raw X-PAYMENT headers the guard sends — scenario 4 replays one.
  let lastHeader = '';
  const innerPayer = facilitator.payerFor(AGENT_WALLET);
  const payer: Payer = async (requirement, intent, decision) => {
    lastHeader = await innerPayer(requirement, intent, decision);
    return lastHeader;
  };
  const guard = createGuard({
    engineUrl,
    agentId,
    payer,
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  const guarded = guard.wrap();

  console.log(`\n  Vendor    ${vendor.url}  (a plain Node API + gateMiddleware)`);
  console.log(`            /health free · /api/answer $0.05 · POST /api/premium/* $0.25`);
  console.log(`            denylist: ${MULE_WALLET.slice(0, 18)}… (the mule)`);
  console.log(`  Engine    ${engineUrl}`);
  console.log(`  Agent     ${agentId}  wallet ${AGENT_WALLET.slice(0, 18)}…`);
  console.log(`\n  Policy "research-policy":  deny if amount > $1.00, else allow`);

  // ── Scenario 1: the unpaid crawler ─────────────────────────────────────────
  console.log(section('Scenario 1  ·  The unpaid crawler (quotes, not handouts)'));

  const free = await fetch(`${vendor.url}/health`);
  outcome(true, 'GET /health', `HTTP ${free.status} — unpriced routes pass through untouched`);

  const quoted = await fetch(`${vendor.url}/api/answer`);
  const quote = PaymentRequired.parse(await quoted.json());
  const offer = quote.accepts[0]!;
  outcome(false, 'GET /api/answer', `HTTP ${quoted.status} — payment required`);
  console.log(`\n  The 402 is a machine-readable offer, not a dead end:`);
  console.log(`    pay      ${offer.maxAmountRequired} atomic USDC ($0.05) on ${offer.network}`);
  console.log(`    to       ${offer.payTo.slice(0, 18)}…`);
  console.log(`    for      ${offer.resource}`);

  // ── Scenario 2: the guarded purchase ───────────────────────────────────────
  console.log(section('Scenario 2  ·  Guarded purchase (Rein on both sides)'));

  const res = await guarded(`${vendor.url}/api/answer`);
  const agentReceipt = guard.receipts().at(-1)!;
  const gateReceipt = gate.receipts.at(-1)!;
  outcome(true, 'GET /api/answer  $0.05', `HTTP ${res.status} · ${JSON.stringify(await res.json())}`);
  console.log(`\n  One payment, four independent records that all agree:`);
  console.log(`    agent receipt   ${agentReceipt.id.slice(0, 18)}…  tx ${agentReceipt.settlement?.txHash}`);
  console.log(`    gate receipt    ${gateReceipt.id.slice(0, 18)}…  tx ${gateReceipt.transaction}`);
  console.log(`    ledger entry    memo = ${ledger.entries().at(-1)?.memo?.slice(0, 18)}…  (the intent id)`);
  console.log(`    indexer         ${indexer.settledPayments().length} payment.settled · ${indexer.shadowSpends().length} shadow.spend`);

  // ── Scenario 3: underpayment ───────────────────────────────────────────────
  console.log(section('Scenario 3  ·  Underpayment ($0.005 against a $0.05 quote)'));

  const cheap = await fetch(`${vendor.url}/api/answer`, {
    headers: { 'X-PAYMENT': craftPayment(AGENT_WALLET, '5000') },
  });
  outcome(false, 'pays $0.005', `HTTP ${cheap.status} · ${lastRefusal()}`);
  console.log('\n  The gate cross-checks the payment against its own quote before any');
  console.log('  facilitator round-trip. Wrong amount, wrong recipient, wrong network,');
  console.log('  wrong scheme — all refused at the door.');

  // ── Scenario 4: replay ─────────────────────────────────────────────────────
  console.log(section('Scenario 4  ·  Replay (the same payment, twice)'));

  const replay = await fetch(`${vendor.url}/api/answer`, {
    headers: { 'X-PAYMENT': lastHeader },
  });
  outcome(false, "scenario 2's payment again", `HTTP ${replay.status} · ${lastRefusal()}`);
  console.log('\n  The mock chain would happily settle this twice — EIP-3009 nonce burning');
  console.log('  is an on-chain luxury. The gate burns each payment on first sight, so');
  console.log(`  the ledger still shows ${ledger.entries().length} entry, not 2.`);

  // ── Scenario 5: the blocked payer ──────────────────────────────────────────
  console.log(section('Scenario 5  ·  Blocked payer (screening beats signatures)'));

  const mule = await fetch(`${vendor.url}/api/answer`, {
    headers: { 'X-PAYMENT': craftPayment(MULE_WALLET, '50000') },
  });
  outcome(false, 'mule pays $0.05 exactly', `HTTP ${mule.status} · ${lastRefusal()}`);
  console.log('\n  Right amount, right recipient, right network — wrong payer. Screening');
  console.log('  runs before verify/settle, so a blocked wallet costs the vendor nothing.');

  // ── Scenario 6: premium pricing + the revenue report ───────────────────────
  console.log(section('Scenario 6  ·  Premium route + the revenue report'));

  const premium = await guarded(`${vendor.url}/api/premium/forecast`, { method: 'POST' });
  outcome(true, 'POST /api/premium  $0.25', `HTTP ${premium.status} · ${JSON.stringify(await premium.json())}`);

  const stats = gate.stats();
  console.log(`\n  gate.stats() — what this API actually earned:\n`);
  console.log(`    quotes issued      ${stats.quoted}`);
  console.log(`    payments settled   ${stats.settled}   revenue ${usd(stats.revenue['USDC']!)} USDC`);
  console.log(`    payments refused   ${stats.refused}`);
  for (const [route, line] of Object.entries(stats.routes)) {
    console.log(`    route ${route.padEnd(16)} ${line.settled} settled · ${usd(line.revenue)}`);
  }
  for (const [payerAddr, line] of Object.entries(stats.payers)) {
    console.log(`    payer ${payerAddr.slice(0, 18)}…  ${line.settled} settled · ${usd(line.revenue)}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + bar('═'));
  console.log('  Summary');
  console.log(bar('═'));

  const settled = gateEvents.filter((e) => e.type === 'gate.settled');
  const refused = gateEvents.filter((e) => e.type === 'gate.refused');
  const codes = refused.map((e) => (e.type === 'gate.refused' ? e.code : '')).join(', ');

  console.log(`
  Gate events:        ${gateEvents.length}  (${settled.length} settled, ${refused.length} refused: ${codes})
  Vendor revenue:     ${usd(gate.stats().revenue['USDC']!)} USDC across ${settled.length} payments
  Chain view:         ${ledger.entries().length} ledger entries · ${indexer.settledPayments().length} reconciled · ${indexer.shadowSpends().length} shadow spends
  Agent's own books:  ${guard.receipts().length} guard receipts (every attempt, allowed or not)
  Elapsed:            ${Date.now() - t0}ms
`);

  console.log(bar('═'));
  console.log('  Done.\n');

  await vendor.close();
  await app.close();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
