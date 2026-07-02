/**
 * The console "world": one live instance of the whole Rein stack wired together
 * — the real policy engine (over HTTP, exactly as an SDK client would reach it),
 * the real Gate fronting the world's vendor API (priced routes, screening,
 * replay burn), the session-key signer holding a custodied wallet, and the mock
 * rails (ledger, facilitator, indexer) standing in for the chain. It subscribes
 * to every bus — engine (`intent.created`, `decision.made`), indexer
 * (`payment.settled`, `shadow.spend`), gate (`gate.*`), signer (`signature.*`)
 * — normalizes them into render-ready feed items, and broadcasts to any
 * connected SSE clients.
 *
 * Two custody tiers pay the same gated vendor:
 *   - SDK tier: agents hold their own (mock) wallet; the facilitator settles
 *     flat mock payloads. Bypass is possible — and detected (shadow.spend).
 *   - Session-key tier: the signer holds the wallet; payments are real
 *     EIP-3009 signatures released only against engine-signed vouchers. The
 *     gate's rails verify those signatures cryptographically (offline) before
 *     settling — a forged or tampered authorization genuinely fails here.
 *
 * This is the only place the moving parts are assembled; the HTTP/SSE layer in
 * `api.ts` is a thin shell over the methods returned here.
 */
import type { AddressInfo } from 'node:net';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import {
  newId,
  sumDecimal,
  type Agent,
  type Decision,
  type PaymentIntent,
  type Receipt,
  type ReputationSubject,
} from '@rein/core';
import { PolicyEngine, buildServer } from '@rein/policy-engine';
import {
  createGuard,
  PaymentBlockedError,
  atomicToDecimal,
  networkToChain,
  requirementDecimals,
  resolveAsset,
  type FetchLike,
  type Payer,
  type PaymentRequirement,
} from '@rein/sdk';
import { MockLedger, MockFacilitator, MockIndexer } from '@rein/mock-rails';
import {
  createGate,
  createGatedFetch,
  mockFacilitatorRails,
  GateError,
  type GateRails,
} from '@rein/gate';
import { ReputationGraph, payerCheck } from '@rein/graph';
import { openReinStore } from '@rein/store';
import { SessionSigner, sessionPayerFor, SignerError, type SignRequest } from '@rein/signer';
import {
  chainIdForNetwork,
  encodeSettlementHeader,
  intentNonce,
  transferWithAuthorizationTypes,
  PaymentPayload,
} from '@rein/x402-rails';
import type {
  AgentView,
  ConsoleState,
  DemoStatus,
  FeedItem,
  GateView,
  GraphView,
  PolicyView,
  PolicyRuleView,
  ReputationRow,
  ServerEvent,
  Stats,
} from './wire';

const VENDOR_HOST = 'api.data.test';
const VENDOR_URL = `https://${VENDOR_HOST}/v1/query`;
const PREMIUM_URL = `https://${VENDOR_HOST}/v1/premium`;
const PRICE = '0.01';
const PREMIUM_PRICE = '5.00';
const PRICE_ATOMIC = '10000'; // $0.01 USDC (6 decimals)
/** USDC on Base — built into the SDK's asset resolution, and a real EIP-712
 * verifying contract for the session-key lane (lowercased: no checksum trips). */
const USDC_BASE = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
/** Real-hex addresses: the EIP-3009 lane signs typed data over them. */
const TREASURY = '0x7e57000000000000000000000000000000000001';
const MULE_WALLET = '0xbad0000000000000000000000000000000000666';
const TX_CAP = '0.50';
const HOUR_BUDGET = '0.04';
const SESSION_CAP = '0.02';
const FEED_CAP = 300;

/** The reputation cast, seeded with BACKDATED history at boot (same-day
 * evidence is confidence-discounted to 40%, by design — see @rein/graph):
 * a reputable feed, a sketchy broker that pockets most payments, and a wallet
 * that burned replay slots at OTHER vendors' gates. */
const GOOD_VENDOR = 'good-feeds.test';
const SKETCHY_VENDOR = 'shady-data.test';
const OFFENDER_WALLET = '0xdefec7ed0000000000000000000000000000d00d';
/** Floor shared by the policy rule (vendorReputationLt) and the gate's payerCheck. */
const REP_FLOOR = 40;
/** Scores below this confidence are never enforced — thin history stays unknown. */
const REP_MIN_CONFIDENCE = 0.3;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Governed refusals are the world working as designed — not errors. */
function swallowGoverned(e: unknown): void {
  if (!(e instanceof PaymentBlockedError) && !(e instanceof SignerError)) throw e;
}

/** A handcrafted flat mock payment header (what a rogue client would forge). */
function craftPayment(from: string, value: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from, to: TREASURY, value, asset: USDC_BASE },
    }),
  ).toString('base64');
}

/** EIP-712 domain name/version travel in requirement.extra (per the v1 spec). */
function extraString(requirement: PaymentRequirement, key: string): string | undefined {
  const value = requirement.extra?.[key];
  return typeof value === 'string' ? value : undefined;
}

interface AgentRuntime {
  wallet: string;
  /** A guard-wrapped fetch bound to this agent against the gated vendor. */
  ping: () => Promise<void>;
}

export interface World {
  getState(): ConsoleState;
  subscribe(listener: (ev: ServerEvent) => void): () => void;
  freeze(agentId: string): Promise<boolean>;
  unfreeze(agentId: string): Promise<boolean>;
  pingAgent(agentId: string): Promise<boolean>;
  runDemo(): boolean;
  close(): Promise<void>;
}

export interface WorldOptions {
  /**
   * PGlite data directory. When set, the WHOLE world runs on @rein/store —
   * the policy engine (agents, policies, decision chain, rolling spend), the
   * reputation graph (evidence + intent correlation), the gate (receipts,
   * revenue, replay slots), and the signer (sessions, spend accounting,
   * burned vouchers) all survive restarts; the boot seed + scenario run only
   * when the store is fresh. Omit for the classic in-memory world.
   *
   * The feed and mock ledger stay ephemeral either way (this process's
   * telemetry, not state). Resumed agents are PINGABLE: SDK-tier runtimes
   * rebuild from the persisted wallet address, and session-tier agents get a
   * ROTATED key + fresh session at boot — custody private keys are
   * deliberately never persisted, and identity linking keeps one reputation
   * across the rotation.
   */
  dataDir?: string;
}

export async function createWorld(options: WorldOptions = {}): Promise<World> {
  const store = options.dataDir ? await openReinStore({ dir: options.dataDir }) : undefined;
  const engine = store ? new PolicyEngine(store) : new PolicyEngine();
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const ledger = new MockLedger();
  const facilitator = new MockFacilitator({ ledger, name: 'mock-facilitator' });
  const indexer = new MockIndexer({
    ledger,
    agents: () => engine.agents.list(),
    facilitator: facilitator.name,
  });
  indexer.connectEngine(engine);

  // The signer holds session-tier wallet keys; vouchers verify against the
  // engine's pinned public key — the same one the console's audit panel shows.
  // On a persistent world, sessions/spend/burned vouchers ride the store; the
  // KEYS never do (rotated at boot — see rebuildRuntime).
  const signer = new SessionSigner({
    enginePublicKeyPem: engine.publicKeyPem,
    ...(store ? { store: store.sessions } : {}),
  });

  // The reputation graph (Phase 3) watches every bus in this world. Scores are
  // pure functions of the evidence it accumulates — recomputed per call, never
  // stored — and feed back into enforcement on both sides: vendor scores sync
  // into the engine (vendorReputationLt fires), payer scores screen the gate.
  // On a persistent world the SAME store backs the evidence ledger, so the
  // scoreboard survives restarts alongside the engine state it governs.
  const graph = store
    ? new ReputationGraph({ ledger: store.ledger, intents: store.intents })
    : new ReputationGraph();

  // EIP-3009 nonces are keccak256(intent.id); remembering the mapping lets the
  // rails settle session-tier payments onto the ledger with the intent-id memo
  // the indexer reconciles on — the mock twin of on-chain nonce reconciliation.
  const intentIdOfNonce = new Map<string, string>();

  /**
   * The gate's settlement seam, dual-dialect: flat mock payloads go through the
   * MockFacilitator exactly as before; EIP-3009 payloads from the signer are
   * verified cryptographically right here (recover the typed-data signer, check
   * the validity window — what USDC's contract would enforce on-chain) and
   * settled straight onto the mock ledger.
   */
  function worldRails(): GateRails {
    const mock = mockFacilitatorRails(facilitator);
    const decodeEvm = (header: string) => {
      try {
        const json: unknown = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        const parsed = PaymentPayload.safeParse(json);
        return parsed.success ? parsed.data : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      async verify(header, requirement) {
        const evm = decodeEvm(header);
        if (!evm) return mock.verify(header, requirement);
        const auth = evm.payload.authorization;
        const chainId = chainIdForNetwork(evm.network);
        if (chainId === undefined) {
          throw new GateError('verify_failed', `cannot verify on network "${evm.network}"`);
        }
        let recovered: string;
        try {
          recovered = await recoverTypedDataAddress({
            domain: {
              name: extraString(requirement, 'name') ?? 'USDC',
              version: extraString(requirement, 'version') ?? '2',
              chainId,
              verifyingContract: requirement.asset as Hex,
            },
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
            signature: evm.payload.signature as Hex,
          });
        } catch (err) {
          throw new GateError(
            'verify_failed',
            `EIP-3009 signature did not parse: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (recovered.toLowerCase() !== auth.from.toLowerCase()) {
          throw new GateError(
            'verify_failed',
            'signature does not recover to the payer — forged or tampered authorization',
          );
        }
        const now = Math.floor(Date.now() / 1000);
        if (now < Number(auth.validAfter) || now >= Number(auth.validBefore)) {
          throw new GateError('verify_failed', 'authorization is outside its validity window');
        }
      },
      async settle(header, requirement) {
        const evm = decodeEvm(header);
        if (!evm) return mock.settle(header, requirement);
        const auth = evm.payload.authorization;
        const chain = networkToChain(evm.network);
        const asset = resolveAsset(requirement);
        if (!chain || !asset) {
          throw new GateError(
            'settle_failed',
            `cannot settle "${requirement.asset}" on "${evm.network}"`,
          );
        }
        const entry = ledger.transfer({
          chain,
          asset,
          from: auth.from,
          to: auth.to,
          amount: atomicToDecimal(auth.value, requirementDecimals(requirement)),
          memo: intentIdOfNonce.get(auth.nonce.toLowerCase()),
        });
        const response = {
          success: true,
          transaction: entry.txHash,
          network: evm.network,
          payer: auth.from,
        };
        return {
          header: encodeSettlementHeader(response),
          transaction: entry.txHash,
          network: evm.network,
          payer: auth.from,
        };
      },
    };
  }

  // ONE gated vendor fronts the whole world: two priced routes, a denylisted
  // mule, real receipts. Both custody tiers pay it; crawlers get quoted.
  const gate = createGate({
    routes: [
      { path: '/v1/query', price: PRICE, description: 'one data query' },
      { path: '/v1/premium', price: PREMIUM_PRICE, description: 'premium intelligence report' },
    ],
    rails: worldRails(),
    payTo: TREASURY,
    network: 'base',
    asset: USDC_BASE,
    screen: {
      denyPayers: [MULE_WALLET],
      // Dynamic screening: a confidently low-rep wallet is turned away at the
      // door before any settle leg; unknowns and thin histories always pass.
      check: payerCheck(graph, { denyBelow: REP_FLOOR, minConfidence: REP_MIN_CONFIDENCE }),
    },
    // Persistent world: receipts/revenue resume, and a payment settled before
    // a kill is refused as a replay after the restart.
    ...(store ? { store: store.gate } : {}),
  });
  const gatedFetch = createGatedFetch(gate, {
    serve: ({ url }) =>
      new Response(
        JSON.stringify(
          new URL(url).pathname === '/v1/premium'
            ? { report: 'premium intelligence', confidence: 0.97 }
            : { rows: 42 },
        ),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  });

  // ── server-side derived state ────────────────────────────────────────────
  const startedAt = new Date().toISOString();
  const intents = new Map<string, PaymentIntent>();
  const spend = new Map<string, string[]>(); // agentId -> allowed amounts
  const runtimes = new Map<string, AgentRuntime>();
  const feed: FeedItem[] = [];
  const listeners = new Set<(ev: ServerEvent) => void>();
  let seq = 0;
  // Resume the run counter from resumed agent names so a restarted persistent
  // world's next run doesn't mint a duplicate "research-agent-1".
  let demoRuns = engine.agents.list().reduce((max, a) => {
    const m = /^research-agent-(\d+)$/.exec(a.name);
    return m ? Math.max(max, Number(m[1])) : max;
  }, 0);
  let demo: DemoStatus = { running: false, phase: 'idle' };
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  let lastSyncAt: string | null = null;
  /** Hosts whose scores the engine currently holds (pushed by syncVendors). */
  const syncedHosts = new Set<string>();

  function emit(ev: ServerEvent): void {
    for (const l of listeners) l(ev);
  }

  function agentName(id: string | undefined): string | undefined {
    if (!id) return undefined;
    return engine.agents.list().find((a) => a.id === id)?.name;
  }

  function agentByWallet(address: string | undefined): Agent | undefined {
    if (!address) return undefined;
    const key = address.toLowerCase();
    return engine.agents
      .list()
      .find((a) => a.wallets.some((w) => w.address.toLowerCase() === key));
  }

  function pushFeed(item: FeedItem): void {
    feed.push(item);
    if (feed.length > FEED_CAP) feed.shift();
    emit({ type: 'feed', item });
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'stats', stats: computeStats() });
  }

  function viewAgents(): AgentView[] {
    return engine.agents.list().map((a: Agent): AgentView => {
      const amounts = spend.get(a.id) ?? [];
      const wallet = a.wallets[0];
      return {
        id: a.id,
        name: a.name,
        status: engine.agents.isFrozen(a.id) ? 'frozen' : 'active',
        mode: wallet?.mode ?? 'observed',
        chain: wallet?.chain ?? '—',
        address: wallet?.address ?? '',
        spent: sumDecimal(amounts),
        calls: amounts.length,
        createdAt: a.createdAt.toISOString(),
      };
    });
  }

  function summarizeRule(rule: {
    id: string;
    allow?: unknown;
    deny?: unknown;
    escalate?: unknown;
  }): PolicyRuleView {
    const action: PolicyRuleView['action'] = rule.deny ? 'deny' : rule.escalate ? 'escalate' : 'allow';
    const cond = (rule.deny ?? rule.escalate ?? rule.allow) as Record<string, unknown> | undefined;
    return { id: rule.id, action, summary: summarizeCondition(cond) };
  }

  function summarizeCondition(c: Record<string, unknown> | undefined): string {
    if (!c) return 'always';
    const parts: string[] = [];
    if (typeof c.amountGt === 'string') parts.push(`amount > $${c.amountGt}`);
    const rolling = c.rollingSum as { window: string; gt: string } | undefined;
    if (rolling) parts.push(`rolling ${rolling.window} > $${rolling.gt}`);
    const txc = c.txCount as { window: string; gt: number } | undefined;
    if (txc) parts.push(`${txc.gt} tx / ${txc.window}`);
    if (Array.isArray(c.vendorHostIn)) parts.push(`vendor in ${c.vendorHostIn.join(', ')}`);
    if (c.vendorFirstSeen === true) parts.push('first-seen vendor');
    if (typeof c.vendorReputationLt === 'number') parts.push(`reputation < ${c.vendorReputationLt}`);
    return parts.length > 0 ? parts.join(' AND ') : 'matches';
  }

  function viewPolicies(): PolicyView[] {
    return engine.policies.list().map((p): PolicyView => ({
      policyId: p.policyId,
      version: p.version,
      default: p.default,
      agents: p.appliesTo.agents ?? [],
      rules: p.rules.map(summarizeRule),
    }));
  }

  function viewGate(): GateView {
    const s = gate.stats();
    return {
      payTo: TREASURY,
      network: 'base',
      quoted: s.quoted,
      settled: s.settled,
      refused: s.refused,
      // Keyed by asset AS QUOTED (the USDC contract address here) — this world
      // is single-asset, so the total is just the sum across keys.
      revenue: sumDecimal(Object.values(s.revenue)),
      routes: Object.entries(s.routes).map(([route, line]) => ({ route, ...line })),
      payers: Object.entries(s.payers).map(([payer, line]) => ({
        payer,
        agentName: agentByWallet(payer)?.name,
        ...line,
      })),
    };
  }

  function reputationRow(subject: ReputationSubject): ReputationRow | undefined {
    const explained = graph.explain(subject);
    if (!explained) return undefined;
    const { score, evidence } = explained;
    // Linked identities (agent ULID <- wallet, vendor host <- payTo) merge
    // into ONE row now. The wallet/treasury fallbacks below only fire for
    // UNLINKED subjects — wallets with no registered agent (the offender, the
    // mule) and foreign payTo addresses.
    const byWallet = agentByWallet(subject.id)?.name;
    const label =
      subject.kind === 'agent'
        ? agentName(subject.id) ?? (byWallet ? `${byWallet} (wallet)` : undefined)
        : subject.id === TREASURY
          ? 'gate treasury (payTo)'
          : undefined;
    return {
      kind: subject.kind,
      id: subject.id,
      label,
      score: score.score,
      confidence: score.confidence,
      components: score.components,
      attempts: evidence.attempts,
      settled: evidence.settled,
      volume: evidence.volume,
      refusals: Object.values(evidence.refusals).reduce((a, b) => a + b, 0),
      shadowSpends: evidence.shadowSpends,
      disputes: evidence.disputes,
      endorsements: evidence.endorsements,
      firstSeen: evidence.firstSeen.toISOString(),
      synced: subject.kind === 'vendor' && syncedHosts.has(subject.id),
      barred:
        subject.kind === 'agent' &&
        score.confidence >= REP_MIN_CONFIDENCE &&
        score.score < REP_FLOOR,
    };
  }

  function viewGraph(): GraphView {
    const rows = (kind: 'vendor' | 'agent') =>
      graph
        .scores(kind) // best first
        .map((s) => reputationRow(s.subject))
        .filter((r): r is ReputationRow => r !== undefined);
    return {
      subjects: graph.subjects(),
      vendors: rows('vendor'),
      agents: rows('agent'),
      syncedCount: syncedHosts.size,
      lastSyncAt,
      minConfidence: REP_MIN_CONFIDENCE,
      denyBelow: REP_FLOOR,
    };
  }

  function computeStats(): Stats {
    const decisions = feed.filter((f) => f.kind === 'decision');
    const settled = feed.filter((f) => f.kind === 'settled');
    const shadow = feed.filter((f) => f.kind === 'shadow');
    const latencies = decisions
      .map((d) => d.latencyMs)
      .filter((n): n is number => typeof n === 'number');
    const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
    const gateStats = gate.stats();
    return {
      decisions: decisions.length,
      allow: decisions.filter((d) => d.outcome === 'allow').length,
      deny: decisions.filter((d) => d.outcome === 'deny').length,
      escalate: decisions.filter((d) => d.outcome === 'escalate').length,
      settled: settled.length,
      shadow: shadow.length,
      settledValue: sumDecimal(settled.map((s) => s.amount ?? '0')),
      shadowValue: sumDecimal(shadow.map((s) => s.amount ?? '0')),
      agents: engine.agents.list().length,
      chainLinks: engine.decisions().length,
      avgLatencyMs: Math.round(avg * 1000) / 1000,
      revenue: sumDecimal(Object.values(gateStats.revenue)),
      quoted: gateStats.quoted,
      gateRefused: gateStats.refused,
      sigReleased: feed.filter((f) => f.kind === 'signature').length,
      sigRefused: feed.filter((f) => f.kind === 'sig-refused').length,
    };
  }

  // ── event wiring ───────────────────────────────────────────────────────────
  engine.onEvent((ev) => {
    if (ev.type === 'intent.created') {
      intents.set(ev.intent.id, ev.intent);
      intentIdOfNonce.set(intentNonce(ev.intent.id).toLowerCase(), ev.intent.id);
      return;
    }
    if (ev.type === 'decision.made') {
      const d: Decision = ev.decision;
      const intent = intents.get(d.intentId);
      const agentId = intent?.agentId;
      if (d.outcome === 'allow' && intent && agentId) {
        const list = spend.get(agentId) ?? [];
        list.push(intent.amount);
        spend.set(agentId, list);
      }
      pushFeed({
        seq: ++seq,
        at: d.decidedAt.toISOString(),
        kind: 'decision',
        agentId,
        agentName: agentName(agentId),
        amount: intent?.amount,
        host: intent?.vendor.host,
        resource: intent?.resource,
        intentId: d.intentId,
        outcome: d.outcome,
        reason: d.reason,
        matchedRules: d.matchedRules,
        policyId: d.policyId,
        latencyMs: d.latencyMs,
        decisionId: d.id,
        hash: d.hash,
        prevHash: d.prevHash,
      });
    }
  });

  indexer.onEvent((ev) => {
    if (ev.type === 'payment.settled') {
      const intent = intents.get(ev.payment.intentId);
      pushFeed({
        seq: ++seq,
        at: ev.payment.confirmedAt.toISOString(),
        kind: 'settled',
        agentId: intent?.agentId,
        agentName: agentName(intent?.agentId),
        amount: intent?.amount,
        host: intent?.vendor.host,
        intentId: ev.payment.intentId,
        txHash: ev.payment.txHash,
        chain: ev.payment.chain,
        blockNumber: ev.payment.blockNumber.toString(),
      });
    } else if (ev.type === 'shadow.spend') {
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'shadow',
        agentId: ev.agentId,
        agentName: agentName(ev.agentId),
        amount: ev.amount,
        txHash: ev.txHash,
        chain: ev.chain,
      });
    }
  });

  gate.onEvent((ev) => {
    if (ev.type === 'gate.quoted') {
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'quote',
        amount: ev.amount,
        host: VENDOR_HOST,
        resource: ev.resource,
        method: ev.method,
      });
    } else if (ev.type === 'gate.settled') {
      const r = ev.receipt;
      const payerAgent = agentByWallet(r.payer);
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'revenue',
        agentId: payerAgent?.id,
        agentName: payerAgent?.name,
        amount: r.amount,
        host: VENDOR_HOST,
        resource: r.resource,
        route: r.route,
        payer: r.payer,
        txHash: r.transaction,
      });
    } else if (ev.type === 'gate.refused') {
      const payerAgent = agentByWallet(ev.payer);
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'gate-refused',
        agentId: payerAgent?.id,
        agentName: payerAgent?.name,
        host: VENDOR_HOST,
        resource: ev.resource,
        payer: ev.payer,
        code: ev.code,
        reason: ev.reason,
      });
    }
    emit({ type: 'gate', gate: viewGate() });
  });

  signer.onEvent((ev) => {
    if (ev.type === 'signature.released') {
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'signature',
        agentId: ev.agentId,
        agentName: agentName(ev.agentId),
        amount: ev.amount,
        intentId: ev.intentId,
        decisionId: ev.decisionId,
        sessionId: ev.sessionId,
      });
    } else if (ev.type === 'signature.refused') {
      pushFeed({
        seq: ++seq,
        at: ev.at.toISOString(),
        kind: 'sig-refused',
        agentId: ev.agentId,
        agentName: agentName(ev.agentId),
        intentId: ev.intentId,
        sessionId: ev.sessionId,
        code: ev.code,
        reason: ev.reason,
      });
    }
  });

  // ── reputation wiring ──────────────────────────────────────────────────────
  // The graph ingests every bus. Engine-side subjects (agent ULIDs, vendor
  // hosts) and gate-side subjects (payer wallets, payTo addresses) are disjoint
  // id spaces, so feeding one graph from all four buses never double-counts.
  graph.observe(engine).observe(indexer).observe(gate).observe(signer);

  // Identity linking (the ERC-8004 story, sourced locally): this world KNOWS
  // which wallet belongs to which agent (its own registry) and that the gate's
  // payTo is the world vendor's treasury — so evidence merges across the id
  // spaces instead of splitting one party into two scoreboard rows. Links are
  // derived state: re-asserted at boot (idempotent), never persisted.
  function linkAgentIdentity(agent: Agent): void {
    for (const w of agent.wallets) {
      graph.link({ kind: 'agent', id: agent.id }, { kind: 'agent', id: w.address });
    }
  }
  graph.link({ kind: 'vendor', id: VENDOR_HOST }, { kind: 'vendor', id: TREASURY });
  for (const agent of engine.agents.list()) linkAgentIdentity(agent); // resumed agents

  /** Push confident vendor scores into the engine and broadcast the panel. */
  async function syncGraph(): Promise<void> {
    const pushed = await graph.syncVendors(engine.spend, { minConfidence: REP_MIN_CONFIDENCE });
    for (const p of pushed) syncedHosts.add(p.host);
    lastSyncAt = new Date().toISOString();
    emit({ type: 'graph', graph: viewGraph() });
  }

  // Sync is a snapshot push, not a subscription — re-push shortly after any
  // burst of new evidence so vendorReputationLt always sees current scores.
  function scheduleSync(): void {
    if (syncTimer) return;
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      syncGraph().catch((err: unknown) =>
        console.error('[console] reputation sync failed:', err),
      );
    }, 250);
  }
  for (const bus of [engine, indexer, gate, signer]) bus.onEvent(() => scheduleSync());

  // ── imported reputation history ────────────────────────────────────────────
  // Live evidence is same-day and confidence-discounted, so a brand-new world
  // would have nothing enforceable. Seed the graph with two weeks of backdated
  // history — the receipts a deployment would have accumulated before this
  // console booted. The world's own vendor (api.data.test) is deliberately NOT
  // seeded: watch its confidence climb live as scenario runs accumulate.
  function seedReputationHistory(): void {
    const start = Date.now() - 14 * DAY_MS;
    const historian = newId('agt'); // the fictional pre-console agent on those receipts
    const receipt = (host: string, at: Date, settled: boolean): Receipt => ({
      id: newId('rcp'),
      agentId: historian,
      intentId: newId('int'),
      decisionId: newId('dec'),
      outcome: 'allow',
      url: `https://${host}/v1/query`,
      method: 'GET',
      vendorHost: host,
      amount: '0.05',
      asset: 'USDC',
      chain: 'base',
      taskContext: {},
      settlement: settled ? { txHash: `0x5eed${at.getTime().toString(16)}` } : undefined,
      createdAt: at,
    });
    for (let i = 0; i < 15; i += 1) {
      const at = new Date(start + i * 22 * HOUR_MS);
      graph.ingestReceipt(receipt(GOOD_VENDOR, at, true)); // 15/15 settled
      graph.ingestReceipt(receipt(SKETCHY_VENDOR, at, i < 2)); // 2/15 settled
    }
    for (let i = 0; i < 3; i += 1) {
      graph.report({
        subject: { kind: 'vendor', id: SKETCHY_VENDOR },
        kind: 'dispute',
        at: new Date(start + (4 + i * 3) * DAY_MS),
        note: 'chargeback reported out-of-band',
      });
    }
    // The offender: one payment replayed 12 times at OTHER vendors' gates.
    for (let i = 0; i < 12; i += 1) {
      graph.ingest({
        type: 'gate.refused',
        at: new Date(start + i * 12 * HOUR_MS),
        code: 'payment_replayed',
        reason: 'replay of an already-settled payment',
        resource: 'https://other-vendor.example/api/answer',
        payer: OFFENDER_WALLET,
      });
    }
  }

  // ── agent provisioning ───────────────────────────────────────────────────
  // Engine writes are AWAITED: on a persistent store they land on disk before
  // the working set reflects them, and the very next scenario beat evaluates
  // against this agent — an unawaited write would race it. (In-memory stores
  // resolve immediately, so the await costs nothing there.)
  async function addAgentPolicy(name: string, agentId: string, wallet: { address: string; mode: 'sdk' | 'session-key' }): Promise<void> {
    const agent = await engine.registerAgent({
      id: agentId,
      orgId: newId('org'),
      name,
      wallets: [{ chain: 'base', address: wallet.address, mode: wallet.mode }],
      status: 'active',
      createdAt: new Date(),
    });
    // One party, one score: the wallet's gate-side evidence folds into the
    // engine agent from the moment it exists.
    linkAgentIdentity(agent);
    await engine.addPolicy({
      policyId: `policy-${name}`,
      appliesTo: { agents: [agentId] },
      rules: [
        { id: 'tx-cap', deny: { amountGt: TX_CAP } },
        { id: 'hour-budget', deny: { rollingSum: { window: '1h', gt: HOUR_BUDGET } } },
        // Fires only on a KNOWN bad score — the graph withholds low-confidence
        // scores at sync, so unknown vendors stay ungoverned by this rule.
        { id: 'reputation-gate', deny: { vendorReputationLt: REP_FLOOR } },
      ],
      default: 'allow',
    });
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'policies', policies: viewPolicies() });
  }

  function registerRuntime(agentId: string, wallet: string, wrapped: FetchLike): FetchLike {
    runtimes.set(agentId, {
      wallet,
      ping: async () => {
        await wrapped(VENDOR_URL).catch(swallowGoverned);
      },
    });
    return wrapped;
  }

  /** SDK tier: the agent holds its own (mock) wallet key. */
  async function provisionAgent(name: string): Promise<{
    agentId: string;
    wallet: string;
    fetch: FetchLike;
    lastHeader: () => string;
  }> {
    const agentId = newId('agt');
    const wallet = `0x${name.replace(/[^a-z0-9]/gi, '')}Wallet`;
    await addAgentPolicy(name, agentId, { address: wallet, mode: 'sdk' });
    // Capture raw X-PAYMENT headers — the replay scenario re-presents one.
    let captured = '';
    const inner = facilitator.payerFor(wallet);
    const payer: Payer = async (requirement, intent, decision) => {
      captured = await inner(requirement, intent, decision);
      return captured;
    };
    const guard = createGuard({ engineUrl, agentId, fetch: gatedFetch, payer });
    const wrapped = registerRuntime(agentId, wallet, guard.wrap());
    return { agentId, wallet, fetch: wrapped, lastHeader: () => captured };
  }

  /** Session-key tier: the wallet key never leaves the signer. */
  async function provisionSessionAgent(name: string): Promise<{
    agentId: string;
    wallet: string;
    fetch: FetchLike;
    sessionToken: string;
    lastSignRequest: () => SignRequest | undefined;
  }> {
    const agentId = newId('agt');
    const wallet = signer.registerWallet(agentId, generatePrivateKey());
    await addAgentPolicy(name, agentId, { address: wallet, mode: 'session-key' });
    const { token } = await signer.createSession({
      agentId,
      capAmount: SESSION_CAP,
      ttlSeconds: 24 * 3600,
    });
    // Capture the voucher the guard hands the signer — the stolen-voucher
    // scenario replays it. Captured BEFORE signing: the decision burns on use.
    let captured: SignRequest | undefined;
    const inner = sessionPayerFor(signer, token);
    const payer: Payer = (requirement, intent, decision) => {
      captured = { sessionToken: token, requirement, intent, decision };
      return inner(requirement, intent, decision);
    };
    const guard = createGuard({ engineUrl, agentId, fetch: gatedFetch, payer });
    const wrapped = registerRuntime(agentId, wallet, guard.wrap());
    return { agentId, wallet, fetch: wrapped, sessionToken: token, lastSignRequest: () => captured };
  }

  /**
   * Rebuild a pingable runtime for an agent RESUMED from the store. SDK-tier
   * runtimes rebuild directly from the persisted wallet address. Session-tier
   * runtimes need secrets a restart loses on purpose — the custodied private
   * key and the bearer token are never persisted — so the agent's key is
   * ROTATED: a fresh key into the signer's custody, the agent doc re-registered
   * under the new address, and a fresh capped session minted. Identity linking
   * folds the new wallet into the agent's existing reputation (the old
   * wallet's evidence was durably merged when it was linked), so one party
   * keeps one score across the rotation.
   */
  async function rebuildRuntime(agent: Agent): Promise<void> {
    if (runtimes.has(agent.id)) return;
    const wallet = agent.wallets[0];
    if (!wallet) return;
    if (wallet.mode === 'session-key') {
      const address = signer.registerWallet(agent.id, generatePrivateKey());
      // The new wallet goes FIRST (wallets[0] = current); the old ones stay in
      // the doc so every future boot's re-link still knows them — evidence that
      // arrives against a retired wallet (e.g. a replayed pre-kill payment
      // header refused at the gate) must keep folding into THIS agent, not
      // mint a stray unlinked scoreboard row.
      const rotated = await engine.registerAgent({
        ...agent,
        wallets: [{ chain: 'base', address, mode: 'session-key' }, ...agent.wallets],
      });
      linkAgentIdentity(rotated);
      // The previous boot's grant died with its token — revoke it (durably)
      // rather than leave spent authority dangling until TTL.
      for (const stale of signer.sessions()) {
        if (stale.agentId === agent.id && stale.revokedAt === undefined) {
          await signer.revokeSession(stale.id);
        }
      }
      const { token } = await signer.createSession({
        agentId: agent.id,
        capAmount: SESSION_CAP,
        ttlSeconds: 24 * 3600,
      });
      const payer = sessionPayerFor(signer, token);
      const guard = createGuard({ engineUrl, agentId: agent.id, fetch: gatedFetch, payer });
      registerRuntime(agent.id, address, guard.wrap());
    } else {
      const payer: Payer = facilitator.payerFor(wallet.address);
      const guard = createGuard({ engineUrl, agentId: agent.id, fetch: gatedFetch, payer });
      registerRuntime(agent.id, wallet.address, guard.wrap());
    }
  }

  // ── scripted scenario ──────────────────────────────────────────────────────
  async function playScenario(paced: boolean): Promise<void> {
    const gap = paced ? 650 : 0;
    const setPhase = (phase: string) => {
      demo = { running: true, phase };
      emit({ type: 'demo', demo });
    };

    demoRuns += 1;
    const name = `research-agent-${demoRuns}`;
    setPhase(`spinning up ${name}`);
    const sdk = await provisionAgent(name);
    await sleep(gap);

    // 1 — four allowed, paid calls within the rolling budget (quote → allow →
    //     vendor revenue → on-chain settle, all visible per call)
    setPhase('normal calls within budget');
    for (let i = 0; i < 4; i++) {
      await sdk.fetch(VENDOR_URL);
      await sleep(gap);
    }

    // 2 — the fifth call trips the rolling-budget cap (deny before payment)
    setPhase('rolling-budget cap');
    await sdk.fetch(VENDOR_URL).catch(swallowGoverned);
    await sleep(gap);

    // 3 — the $5.00 premium route trips the per-transaction cap
    setPhase('single-transaction cap');
    await sdk.fetch(PREMIUM_URL).catch(swallowGoverned);
    await sleep(gap);

    // 4 — a direct transfer that bypasses the guard entirely → shadow spend
    setPhase('shadow spend (bypass)');
    ledger.transfer({ chain: 'base', asset: 'USDC', from: sdk.wallet, to: '0xDeadVendor', amount: '2.50' });
    await sleep(gap);

    // 5 — an unpaid crawler probes the API and gets a quote, not a handout
    setPhase('unpaid crawler gets quoted');
    await gatedFetch(VENDOR_URL);
    await sleep(gap);

    // 6 — the same settled payment, presented again → replay burned
    setPhase('replayed payment refused');
    await gatedFetch(VENDOR_URL, { headers: { 'X-PAYMENT': sdk.lastHeader() } });
    await sleep(gap);

    // 7 — a denylisted mule pays the exact right amount → screening refuses
    setPhase('denylisted payer refused');
    await gatedFetch(VENDOR_URL, {
      headers: { 'X-PAYMENT': craftPayment(MULE_WALLET, PRICE_ATOMIC) },
    });
    await sleep(gap);

    // 8 — the custody tier: a session-key agent, wallet held by the signer
    const sessionName = `session-agent-${demoRuns}`;
    setPhase(`spinning up ${sessionName} (key in custody)`);
    const session = await provisionSessionAgent(sessionName);
    await sleep(gap);

    // 9 — two voucher-gated EIP-3009 purchases (signature.released each time)
    setPhase('session-key purchases');
    await session.fetch(VENDOR_URL);
    await sleep(gap);
    await session.fetch(VENDOR_URL);
    await sleep(gap);

    // 10 — a stolen voucher replayed straight at the signer → decision burned
    setPhase('stolen voucher replayed');
    const voucher = session.lastSignRequest();
    if (voucher) await signer.sign(voucher).then(() => undefined, swallowGoverned);
    await sleep(gap);

    // 11 — the engine allows a third $0.01, but the session cap says no:
    //      defense in depth — the key itself is the last line
    setPhase('session cap backstop');
    await session.fetch(VENDOR_URL).catch(swallowGoverned);
    await sleep(gap);

    // 12 — reputation closes the loop on the engine: a fresh agent probes a
    //      vendor the network already burned — denied before any payment exists
    setPhase(`reputation check: ${SKETCHY_VENDOR}`);
    const proc = await provisionAgent(`procurement-agent-${demoRuns}`);
    await proc.fetch(`https://${SKETCHY_VENDOR}/v1/query`).catch(swallowGoverned);
    await sleep(gap);

    // 13 — same agent, same policy, same price, reputable vendor: business as usual
    setPhase(`reputation check: ${GOOD_VENDOR}`);
    await proc.fetch(`https://${GOOD_VENDOR}/v1/query`);
    await sleep(gap);

    // 14 — the offender wallet presents a fresh, valid payment; it never
    //      wronged THIS vendor, but evidence from other gates bars the door
    setPhase('low-reputation payer at the door');
    await gatedFetch(VENDOR_URL, {
      headers: { 'X-PAYMENT': craftPayment(OFFENDER_WALLET, PRICE_ATOMIC) },
    });
    await sleep(gap);

    demo = { running: false, phase: 'idle' };
    emit({ type: 'demo', demo });
  }

  // ── public API ─────────────────────────────────────────────────────────────
  function runDemo(): boolean {
    if (demo.running) return false;
    demo = { running: true, phase: 'starting' };
    emit({ type: 'demo', demo });
    void playScenario(true).catch((err) => {
      console.error('[console] demo run failed:', err);
      demo = { running: false, phase: 'idle' };
      emit({ type: 'demo', demo });
    });
    return true;
  }

  async function freeze(agentId: string): Promise<boolean> {
    if (!engine.agents.list().some((a) => a.id === agentId)) return false;
    await engine.freeze(agentId); // durable stores persist BEFORE the registry reflects it
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'stats', stats: computeStats() });
    return true;
  }

  async function unfreeze(agentId: string): Promise<boolean> {
    if (!engine.agents.list().some((a) => a.id === agentId)) return false;
    await engine.unfreeze(agentId);
    emit({ type: 'agents', agents: viewAgents() });
    emit({ type: 'stats', stats: computeStats() });
    return true;
  }

  async function pingAgent(agentId: string): Promise<boolean> {
    const rt = runtimes.get(agentId);
    if (!rt) return false;
    await rt.ping();
    return true;
  }

  function getState(): ConsoleState {
    return {
      feed: [...feed],
      agents: viewAgents(),
      policies: viewPolicies(),
      stats: computeStats(),
      gate: viewGate(),
      graph: viewGraph(),
      demo,
      publicKey: engine.publicKeyPem,
      startedAt,
    };
  }

  function subscribe(listener: (ev: ServerEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  async function close(): Promise<void> {
    if (syncTimer) clearTimeout(syncTimer);
    await app.close();
    // Flush write-behind reputation evidence before the handle goes away. A
    // failure here means some evidence was NOT persisted — log it loudly, but
    // don't take the dev-server teardown down with it.
    if (store) {
      await store.close().catch((err: unknown) => {
        console.error('[console] store close failed (unflushed evidence may be lost):', err);
      });
    }
  }

  // Seed an initial story so the console is alive on first load — but only on
  // a FRESH store. A resumed world already carries its history (re-seeding
  // would double-count the imported evidence), so it boots straight onto the
  // resumed state; the feed starts empty because it is telemetry, not state.
  // Reputation history lands first and is synced into the engine BEFORE the
  // scenario, so the reputation-gate beats evaluate against current scores.
  const fresh = store?.fresh ?? true;
  if (fresh) seedReputationHistory();
  // Resumed agents get live runtimes again (no-op on a fresh world — the
  // scenario provisions its own). Session-tier keys rotate here, BEFORE the
  // first sync, so the scoreboard's first frame already shows merged identities.
  for (const agent of engine.agents.list()) await rebuildRuntime(agent);
  await syncGraph();
  if (fresh) await playScenario(false);
  if (store) {
    console.log(
      `[rein] console world on ${options.dataDir}: ` +
        (fresh
          ? 'fresh store (seeded)'
          : `resumed ${store.resumedDecisions} decisions, ${store.resumedSubjects} reputation subjects, ` +
            `${engine.agents.list().length} agents, ${store.resumedSessions} signer sessions, ` +
            `${store.resumedReceipts} gate receipts`),
    );
  }

  return { getState, subscribe, freeze, unfreeze, pingAgent, runDemo, close };
}
