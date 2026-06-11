/**
 * Rein — Graph Demo (Phase 3: reputation closes the loop)
 *
 * Guard receipts say what agents tried to spend; gate receipts say what
 * vendors actually earned. @rein/graph turns both into explainable reputation
 * scores and feeds them back into enforcement on BOTH sides of the wire:
 * vendor scores land in the engine (policies with `vendorReputationLt` start
 * firing), payer scores land in gate screening (low-rep wallets are turned
 * away at the door).
 *
 * Five scenarios, fully offline, <1s:
 *   1. Day 0 — a reputation policy must NOT fire on an unknown vendor
 *   2. Two weeks of history — one vendor settles everything, one barely
 *      settles and picks up chargebacks
 *   3. The scoreboard — five components + confidence, straight off evidence
 *   4. The sync — same agent, same policy, same $0.05: sketchy now DENIED
 *   5. The door — replays at one vendor's gate get a mule turned away at
 *      another's, while a brand-new wallet still passes (no data ≠ bad)
 *
 * Run: pnpm --filter @rein/demo demo:graph
 */

import { newId, type ReputationSubject } from '@rein/core';
import { PolicyEngine } from '@rein/policy-engine';
import { createGate, type GateRails } from '@rein/gate';
import { ReputationGraph, payerCheck } from '@rein/graph';

// ─── config ───────────────────────────────────────────────────────────────────

const GOOD_API = 'good-api.example';
const SKETCHY_API = 'sketchy-api.example';
const VENDOR_TREASURY = '0xVendorTreasury0000000000000000000000001';
const MULE_WALLET = '0xMuleWallet00000000000000000000000000666';
const REGULAR_WALLET = '0xRegularCustomer000000000000000000000001';
const NEWCOMER_WALLET = '0xBrandNewWallet0000000000000000000000007';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const W = 64;

// ─── formatting ───────────────────────────────────────────────────────────────

const bar = (c: string) => c.repeat(W);
const section = (label: string) => `\n${bar('─')}\n ${label}\n${bar('─')}`;

function verdict(ok: boolean, label: string, detail: string) {
  const mark = ok ? '✓ ALLOW  ' : '✗ DENIED ';
  console.log(`  ${label.padEnd(30)} ${mark} ${detail}`);
}

function scoreboard(graph: ReputationGraph, subjects: ReputationSubject[]) {
  const f = (n: number) => String(Math.round(n)).padStart(4);
  console.log(
    `    ${'subject'.padEnd(28)} score  conf   rely  disp   vol  long  cpty`,
  );
  for (const subject of subjects) {
    const s = graph.score(subject);
    if (!s) continue;
    const c = s.components;
    const label = `${subject.kind} ${subject.id}`;
    const shown = label.length > 28 ? `${label.slice(0, 27)}…` : label.padEnd(28);
    console.log(
      `    ${shown} ${f(s.score)}  ${s.confidence
        .toFixed(2)
        .padStart(4)}  ${f(c.settlementReliability)}  ${f(c.disputeRate)}  ${f(c.volume)}  ${f(
        c.longevity,
      )}  ${f(c.counterpartyQuality)}`,
    );
  }
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  console.log('\n' + bar('═'));
  console.log('  Rein  ·  Graph Demo');
  console.log('  Phase 3: reputation closes the loop');
  console.log(bar('═'));

  // ── Setup: engine + a reputation policy + the graph on its bus ─────────────

  const engine = new PolicyEngine();
  const graph = new ReputationGraph().observe(engine);

  const agent = await engine.registerAgent({
    id: newId('agt'),
    orgId: newId('org'),
    name: 'research-agent',
    wallets: [],
    status: 'active',
    createdAt: new Date(),
  });
  await engine.addPolicy({
    policyId: 'reputation-policy',
    rules: [{ id: 'reputation-gate', deny: { vendorReputationLt: 40 } }],
    default: 'allow',
  });

  const intentTo = (host: string, createdAt = new Date()) => ({
    agentId: agent.id,
    vendor: { host, address: '0xV' },
    resource: `https://${host}/api/answer`,
    amount: '0.05',
    asset: 'USDC' as const,
    chain: 'base' as const,
    createdAt,
  });

  console.log(`\n  Agent     ${agent.id}`);
  console.log(`  Policy    "reputation-policy": deny if vendor reputation < 40`);
  console.log(`  Graph     observing the engine bus (intents, decisions, settlements)`);

  // ── Scenario 1: day 0 — unknown is not bad ─────────────────────────────────
  console.log(section('Scenario 1  ·  Day 0: no reputation data, no judgment'));

  const fresh = await engine.evaluateIntent(intentTo(SKETCHY_API));
  verdict(
    fresh.decision.outcome === 'allow',
    `$0.05 to ${SKETCHY_API}`,
    'the reputation gate stays silent on an unknown vendor',
  );
  console.log('\n  A policy that froze every newcomer would be a denial-of-business.');
  console.log('  No reputation data is indeterminate — vendorReputationLt only fires');
  console.log('  on a KNOWN bad score, and the graph only publishes confident ones.');

  // ── Scenario 2: two weeks of history ───────────────────────────────────────
  console.log(section('Scenario 2  ·  Two weeks of history, observed off the bus'));

  const start = Date.now() - 14 * DAY;
  let goodSettled = 0;
  let sketchySettled = 0;
  for (let i = 0; i < 15; i += 1) {
    const at = new Date(start + i * 4 * HOUR);
    // good-api: every allowed payment settles (the indexer would emit these).
    const good = await engine.evaluateIntent(intentTo(GOOD_API, at));
    graph.ingest({
      type: 'payment.settled',
      at,
      payment: { intentId: good.intent.id, txHash: `0xgood${i}`, chain: 'base', blockNumber: 1n, confirmedAt: at },
    });
    goodSettled += 1;
    // sketchy-api: paid 15 times, delivered twice.
    const sketchy = await engine.evaluateIntent(intentTo(SKETCHY_API, at));
    if (i < 2) {
      graph.ingest({
        type: 'payment.settled',
        at,
        payment: { intentId: sketchy.intent.id, txHash: `0xsk${i}`, chain: 'base', blockNumber: 1n, confirmedAt: at },
      });
      sketchySettled += 1;
    }
  }
  for (let i = 0; i < 3; i += 1) {
    graph.report({ subject: { kind: 'vendor', id: SKETCHY_API }, kind: 'dispute' });
  }

  console.log(`  ${GOOD_API.padEnd(24)} ${goodSettled}/15 payments settled, 0 disputes`);
  console.log(`  ${SKETCHY_API.padEnd(24)} ${sketchySettled}/16 payments settled, 3 chargebacks reported`);

  // ── Scenario 3: the scoreboard ─────────────────────────────────────────────
  console.log(section('Scenario 3  ·  The scoreboard (no black box)'));

  console.log('');
  scoreboard(graph, [
    { kind: 'vendor', id: GOOD_API },
    { kind: 'vendor', id: SKETCHY_API },
    { kind: 'agent', id: agent.id },
  ]);
  console.log('\n  Every score is recomputed from raw evidence on demand — components are');
  console.log('  0–100 (higher = healthier): settlement reliability, dispute hygiene,');
  console.log('  volume, longevity, and one-hop counterparty quality. Confidence is');
  console.log('  first-class: thin history = low confidence, not a fake number.');

  // ── Scenario 4: the sync ───────────────────────────────────────────────────
  console.log(section('Scenario 4  ·  The loop closes on the engine'));

  const pushed = await graph.syncVendors(engine.spend);
  console.log(`  graph.syncVendors(engine.spend) pushed ${pushed.length} confident scores:`);
  for (const p of pushed) {
    console.log(`    ${p.host.padEnd(24)} score ${String(p.score).padStart(3)}  confidence ${p.confidence.toFixed(2)}`);
  }
  console.log('');

  const denied = await engine.evaluateIntent(intentTo(SKETCHY_API));
  verdict(
    denied.decision.outcome === 'allow',
    `$0.05 to ${SKETCHY_API}`,
    `[${denied.decision.matchedRules.join(', ')}] ${denied.decision.reason ?? ''}`,
  );
  const allowed = await engine.evaluateIntent(intentTo(GOOD_API));
  verdict(allowed.decision.outcome === 'allow', `$0.05 to ${GOOD_API}`, 'reputation 80+, business as usual');
  console.log('\n  Same agent, same policy, same five cents. The only thing that changed');
  console.log('  is what the network now knows. With the engine on @rein/store, the');
  console.log('  pushed scores survive restarts like everything else.');

  // ── Scenario 5: the door ───────────────────────────────────────────────────
  console.log(section('Scenario 5  ·  The loop closes on the gate (the door)'));

  // Two weeks ago, on some OTHER vendor's gate: a mule replaying one payment
  // while a regular customer just pays. The graph watches that bus too.
  const rails: GateRails = {
    async verify() {},
    async settle() {
      return { header: 'c2V0dGxlZA==', transaction: newId('grc'), network: 'base' };
    },
  };
  const header = (from: string, tag: string) =>
    Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: { from, to: VENDOR_TREASURY, value: '50000', asset: 'USDC', tag },
      }),
    ).toString('base64');

  let t = Date.now() - 14 * DAY;
  const elsewhere = createGate({
    routes: [{ path: '/api/*', price: '0.05' }],
    rails,
    payTo: VENDOR_TREASURY,
    network: 'base',
    asset: 'USDC',
    now: () => new Date((t += HOUR / 4)),
  });
  graph.observe(elsewhere);

  const replayed = header(MULE_WALLET, 'the-same-payment');
  for (let i = 0; i < 12; i += 1) {
    await elsewhere.handle({ method: 'GET', url: 'https://other.example/api/answer', payment: replayed });
    await elsewhere.handle({ method: 'GET', url: 'https://other.example/api/answer', payment: header(REGULAR_WALLET, `r${i}`) });
  }
  const muleScore = graph.score({ kind: 'agent', id: MULE_WALLET })!;
  console.log(`  Elsewhere, two weeks ago: the mule presented one payment 12 times`);
  console.log(`  (1 settled, 11 replays burned). The regular customer paid 12 times.\n`);
  scoreboard(graph, [
    { kind: 'agent', id: REGULAR_WALLET },
    { kind: 'agent', id: MULE_WALLET },
  ]);

  // Today, OUR gate screens on the shared graph.
  const door = createGate({
    routes: [{ path: '/api/*', price: '0.05' }],
    rails,
    payTo: VENDOR_TREASURY,
    network: 'base',
    asset: 'USDC',
    screen: { check: payerCheck(graph) },
  });
  graph.observe(door);

  console.log('');
  const url = 'https://our.example/api/answer';
  const muleTry = await door.handle({ method: 'GET', url, payment: header(MULE_WALLET, 'fresh-and-valid') });
  verdict(
    muleTry.kind === 'paid',
    'mule pays $0.05, fresh + valid',
    muleTry.kind === 'refused' ? `HTTP ${muleTry.status} [${muleTry.code}] ${muleTry.reason}` : 'served',
  );
  const regularTry = await door.handle({ method: 'GET', url, payment: header(REGULAR_WALLET, 'fresh') });
  verdict(regularTry.kind === 'paid', 'regular customer pays $0.05', 'screened, verified, settled, served');
  const newcomerTry = await door.handle({ method: 'GET', url, payment: header(NEWCOMER_WALLET, 'first-ever') });
  verdict(newcomerTry.kind === 'paid', 'brand-new wallet pays $0.05', 'no history, no judgment — served');

  console.log('\n  The mule never wronged THIS vendor. Evidence from one gate protected');
  console.log('  another — that is the network effect — while the screening stays fair:');
  console.log('  a confident low score is refused, an empty history is not.');

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n' + bar('═'));
  console.log('  Summary');
  console.log(bar('═'));
  console.log(`
  Subjects scored:    ${graph.subjects()}  (vendors by host/treasury, payers by wallet, agents by id)
  Vendor scores:      ${SKETCHY_API} ${graph.score({ kind: 'vendor', id: SKETCHY_API })!.score} (denied) · ${GOOD_API} ${graph.score({ kind: 'vendor', id: GOOD_API })!.score} (allowed)
  Payer screening:    mule ${muleScore.score} → turned away · newcomer (no data) → served
  Pushed to engine:   ${pushed.length} scores, only above the confidence floor
  Elapsed:            ${Date.now() - t0}ms
`);
  console.log(bar('═'));
  console.log('  Done.\n');
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
