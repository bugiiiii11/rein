/**
 * Rein — ERC-8004 Demo (identity: one on-chain agent, one reputation)
 *
 * The reputation graph sees two disjoint id spaces for the same real-world
 * party: the engine keys agents by ULID, gates key payers by wallet. ERC-8004
 * gives that party ONE on-chain identity (an ERC-721 in the Identity
 * Registry), and @rein/erc8004 turns registry facts — ownerOf, the verified
 * agentWallet — into link facts: the identity becomes the canonical
 * reputation subject and everything else folds in as aliases.
 *
 * Five scenarios, fully offline (in-memory registry twin), <1s:
 *   1. Split identity — one party, two scoreboard rows
 *   2. Registration links them — one eip155-keyed row, history merged
 *   3. Same registration, second local agent — still one row
 *   4. Key rotation — setAgentWallet folds the new key into the same identity
 *   5. Vendors stay host-canonical — the treasury folds into the host and
 *      syncVendors pushes hosts, never identities
 *
 * Run: pnpm --filter @rein/demo demo:erc8004
 */

import { newId, type ReinEvent, type ReputationSubject } from '@rein/core';
import { PolicyEngine } from '@rein/policy-engine';
import { ReputationGraph } from '@rein/graph';
import { MockIdentityRegistry, linkAgentFromRegistry, linkVendorFromRegistry } from '@rein/erc8004';

// ─── config ───────────────────────────────────────────────────────────────────

const API_HOST = 'api.data.example';
const TREASURY = '0xVendorTreasury0000000000000000000000001';
const AGENT_WALLET = '0xAgentWallet000000000000000000000000001';
const ROTATED_WALLET = '0xAgentWallet000000000000000000000000002';
const DAY = 86_400_000;
const HOUR = 3_600_000;
const W = 64;

// ─── formatting ───────────────────────────────────────────────────────────────

const bar = (c: string) => c.repeat(W);
const section = (label: string) => `\n${bar('─')}\n ${label}\n${bar('─')}`;

function rows(graph: ReputationGraph, kind: 'agent' | 'vendor'): ReputationSubject[] {
  return graph.scores(kind).map((s) => s.subject);
}

function showRows(graph: ReputationGraph, kind: 'agent' | 'vendor') {
  for (const subject of rows(graph, kind)) {
    const ev = graph.explain(subject)!.evidence;
    const label = subject.id.length > 44 ? `${subject.id.slice(0, 43)}…` : subject.id;
    console.log(
      `    ${label.padEnd(44)} ${String(ev.attempts).padStart(3)} attempts  ${String(ev.settled).padStart(3)} settled`,
    );
  }
}

// ─── evidence helpers (backdated: same-day evidence is confidence-discounted) ──

function gateSettled(payer: string, payTo: string, at: Date): ReinEvent {
  return {
    type: 'gate.settled',
    at,
    receipt: {
      id: newId('grc'),
      at,
      route: '/api/*',
      resource: '/api/answer',
      method: 'GET',
      payer,
      payTo,
      amount: '0.05',
      amountAtomic: '50000',
      asset: 'USDC',
      network: 'base',
      transaction: `0x${at.getTime().toString(16)}`,
    },
  };
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  const t0 = Date.now();

  console.log('\n' + bar('═'));
  console.log('  Rein  ·  ERC-8004 Demo');
  console.log('  identity: one on-chain agent, one reputation');
  console.log(bar('═'));

  const engine = new PolicyEngine();
  const graph = new ReputationGraph().observe(engine);
  const registry = new MockIdentityRegistry(); // the Identity Registry, offline twin

  const agent = await engine.registerAgent({
    id: newId('agt'),
    orgId: newId('org'),
    name: 'research-agent',
    wallets: [{ chain: 'base', address: AGENT_WALLET, mode: 'session-key' }],
    status: 'active',
    createdAt: new Date(),
  });
  await engine.addPolicy({ policyId: 'allow-all', rules: [], default: 'allow' });

  console.log(`\n  Registry  in-memory ERC-8004 twin (${registry.ref.address})`);
  console.log(`  Agent     ${agent.id}`);
  console.log(`  Wallet    ${AGENT_WALLET}`);

  // ── Scenario 1: split identity ──────────────────────────────────────────────
  console.log(section('Scenario 1  ·  One party, two id spaces, two rows'));

  const start = Date.now() - 14 * DAY;
  for (let i = 0; i < 6; i += 1) {
    const at = new Date(start + i * 5 * HOUR);
    // Engine side: intents evaluated under the agent ULID...
    const { intent } = await engine.evaluateIntent({
      agentId: agent.id,
      vendor: { host: API_HOST, address: '0xV' },
      resource: `https://${API_HOST}/api/answer`,
      amount: '0.05',
      asset: 'USDC',
      chain: 'base',
      createdAt: at,
    });
    graph.ingest({
      type: 'payment.settled',
      at,
      payment: { intentId: intent.id, txHash: `0xeng${i}`, chain: 'base', blockNumber: 1n, confirmedAt: at },
    });
  }
  // ...gate side: the SAME party pays a vendor's gate with its wallet.
  for (let i = 0; i < 4; i += 1) {
    graph.ingest(gateSettled(AGENT_WALLET, TREASURY, new Date(start + i * 7 * HOUR)));
  }

  console.log(`\n  agent rows on the scoreboard: ${rows(graph, 'agent').length}\n`);
  showRows(graph, 'agent');
  console.log('\n  The engine speaks ULID, the gate speaks wallet. Without an identity');
  console.log('  layer, one party is two strangers — and reputation splits in half.');

  // ── Scenario 2: registration links them ────────────────────────────────────
  console.log(section('Scenario 2  ·  Registration: the registry knows they are one'));

  const { tokenId, erc8004Id } = registry.register({ owner: AGENT_WALLET });
  const linked = await linkAgentFromRegistry(graph, registry, {
    id: agent.id,
    erc8004Id,
    wallets: agent.wallets,
  });

  console.log(`  minted    agentId ${tokenId} -> ${erc8004Id}`);
  console.log(`  linked    ${linked.pairs} aliases folded into the on-chain identity\n`);
  showRows(graph, 'agent');
  const merged = graph.explain({ kind: 'agent', id: AGENT_WALLET })!.evidence;
  console.log(`\n  Querying by WALLET answers through the alias: ${merged.attempts} attempts,`);
  console.log(`  ${merged.settled} settled — 6 engine-side + 4 gate-side, one identity, one row.`);

  // ── Scenario 3: same registration, second local agent ──────────────────────
  console.log(section('Scenario 3  ·  A second deployment claims the same identity'));

  const second = await engine.registerAgent({
    id: newId('agt'),
    orgId: newId('org'),
    name: 'research-agent (staging)',
    erc8004Id,
    wallets: [],
    status: 'active',
    createdAt: new Date(),
  });
  for (let i = 0; i < 3; i += 1) {
    const at = new Date(start + (40 + i) * HOUR);
    const { intent } = await engine.evaluateIntent({
      agentId: second.id,
      vendor: { host: API_HOST, address: '0xV' },
      resource: `https://${API_HOST}/api/answer`,
      amount: '0.05',
      asset: 'USDC',
      chain: 'base',
      createdAt: at,
    });
    graph.ingest({
      type: 'payment.settled',
      at,
      payment: { intentId: intent.id, txHash: `0xstg${i}`, chain: 'base', blockNumber: 1n, confirmedAt: at },
    });
  }
  console.log(`  staging ULID ${second.id} accrued 3 settlements of its own`);
  await linkAgentFromRegistry(graph, registry, { id: second.id, erc8004Id, wallets: [] });
  console.log(`  linked -> same erc8004Id\n`);
  showRows(graph, 'agent');
  console.log('\n  Two local ULIDs, one on-chain registration: 13 attempts on ONE row.');
  console.log('  The identity is the party; deployments are just its runtimes.');

  // ── Scenario 4: key rotation ────────────────────────────────────────────────
  console.log(section('Scenario 4  ·  Key rotation: the identity survives the key'));

  registry.setAgentWallet(tokenId, ROTATED_WALLET); // EIP-712-verified on the real chain
  graph.ingest(gateSettled(ROTATED_WALLET, TREASURY, new Date(start + 50 * HOUR)));
  await linkAgentFromRegistry(graph, registry, {
    id: agent.id,
    erc8004Id,
    wallets: [{ address: ROTATED_WALLET }, { address: AGENT_WALLET }], // retired key stays known
  });
  const afterRotation = graph.explain({ kind: 'agent', id: erc8004Id })!.evidence;
  console.log(`  setAgentWallet(${tokenId}, ${ROTATED_WALLET.slice(0, 18)}…)`);
  console.log(`  new key pays a gate -> evidence lands on the SAME identity`);
  console.log(`  attempts ${afterRotation.attempts}, settled ${afterRotation.settled} — nothing split, nothing lost`);

  // ── Scenario 5: vendors stay host-canonical ────────────────────────────────
  console.log(section('Scenario 5  ·  Vendors: hosts stay the enforcement key'));

  const vendorReg = registry.register({ owner: TREASURY });
  await linkVendorFromRegistry(graph, registry, { host: API_HOST, erc8004Id: vendorReg.erc8004Id });
  console.log(`  vendor identity ${vendorReg.erc8004Id}`);
  console.log(`  agentWallet IS the treasury -> payTo evidence folds into the host\n`);
  showRows(graph, 'vendor');
  const pushed = await graph.syncVendors(engine.spend);
  console.log(`\n  syncVendors pushed: ${pushed.map((p) => `${p.host} (${p.score})`).join(', ') || '(none)'}`);
  console.log('  Hosts are what intents carry and what vendorReputationLt matches —');
  console.log('  identities and treasuries are aliases, never enforcement keys.');

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(section('Summary'));
  console.log(`  agent rows    ${rows(graph, 'agent').length} (was 2 before linking; 2 local ULIDs + 2 wallets folded in)`);
  console.log(`  vendor rows   ${rows(graph, 'vendor').length} (host-keyed; treasury + identity are aliases)`);
  console.log(`  registry      links derived from ownerOf/agentWallet — never persisted, re-asserted at boot`);
  console.log(`\n  done in ${Date.now() - t0}ms\n`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
