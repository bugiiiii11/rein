/**
 * The console as a READ-KEY CLIENT of a hosted engine (Sprint 5.1).
 *
 * `createWorld` builds a whole Rein deployment inside the console process — a
 * policy engine, a gate, a signer, a reputation graph, a mock chain and a
 * demo scenario. That is the right shape for a laptop and the wrong shape for
 * app.reinconsole.com, where the world being rendered is somewhere else. This
 * is the other implementation of the same `World` interface: it holds no
 * authority at all, only a `read` API key against `engine.reinconsole.com`,
 * and it renders what that engine says.
 *
 * Two alternatives were rejected before this one (PLAN-PRODUCTION 5.1).
 * Embedding the hosted engine in the console would put a signing key and the
 * evaluate path inside the public web process. Sharing the engine's volume is
 * not possible: Railway gives one volume per service and PGlite is a
 * single-writer database, so two processes opening it is corruption, not
 * clustering.
 *
 * What it deliberately cannot do:
 *
 * - EVERY mutation refuses. Not because the key would be rejected (it would),
 *   but because the console is not where authority lives in this topology.
 *   `freeze`/`unfreeze`/`pingAgent` answer `false`, `runDemo` answers `false`,
 *   and `submitGrant` throws. `REIN_CONSOLE_READONLY=1` already refuses these
 *   at the HTTP layer; this is the same answer one layer down, so the posture
 *   does not depend on a single env var staying set.
 * - The gate, signer and graph panels stay EMPTY. The hosted engine is a
 *   policy engine: it has no receipts, no session keys and no reputation
 *   evidence to serve. Rendering zeros is the honest answer — inventing a
 *   plausible shape would be the dishonest one.
 * - The feed is DECISION-DERIVED and therefore thin. A `Decision` carries its
 *   outcome, reason, rules, policy, latency and chain links, but NOT the
 *   agent, amount or host — those live on the intent, which the engine does
 *   not publish. Reconciliation gaps and parked escalations do carry them, so
 *   rows are enriched by intent id where a join exists and left sparse where
 *   it does not. Every `FeedItem` field but `seq`/`at`/`kind` is optional
 *   precisely so a thin row renders rather than lies.
 */
import { createHash } from 'node:crypto';
import type {
  AgentLivenessView,
  AgentView,
  AllowanceGapView,
  BreakerView,
  ConsoleState,
  EscalationsView,
  EscalationView,
  FeedItem,
  GateView,
  GraphView,
  PolicyRuleView,
  PolicyView,
  ReconciliationView,
  ServerEvent,
  SignerView,
  Stats,
} from './wire';
import type { World } from './world';

/** How often the engine is polled when nothing says otherwise. */
const DEFAULT_POLL_MS = 5_000;
/** Same cap as the local world's feed — this is a dashboard, not an archive. */
const FEED_CAP = 300;
/** How many existing decisions the first poll pulls in to seed the feed. */
const FEED_SEED = 50;
/** Per-request ceiling. A hung engine must not wedge the poll loop forever. */
const REQUEST_TIMEOUT_MS = 10_000;
/** How many decision pages one poll will chase before leaving the rest for the next. */
const MAX_PAGES_PER_POLL = 5;
/** Lately-resolved escalations kept for the panel, matching the local world. */
const ESCALATION_HISTORY = 6;
/**
 * Breakers cost one request PER AGENT, so they are the only fan-out here. A
 * deployment with hundreds of agents would spend its whole poll interval on
 * them; the panel is observability, so it covers the first N and stops.
 */
const BREAKER_AGENT_CAP = 25;

export interface RemoteWorldOptions {
  /** Base URL of the hosted engine, e.g. `https://engine.reinconsole.com`. */
  engineUrl: string;
  /** A `read`-scoped API key. Anything wider is authority this process should not hold. */
  apiKey: string;
  pollMs?: number;
  /** Injected for tests; defaults to the global. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** What `GET /api/status` reports about the link to the engine (5.2). */
export interface RemoteStatus {
  engine: string;
  /** `ok` once a poll has succeeded; `unreachable` before that and after a failure. */
  state: 'ok' | 'unreachable';
  /** Short fingerprint of the engine's decision-signing public key. */
  publicKeyFingerprint?: string;
  /** `decidedAt` of the newest decision this console has seen. */
  lastDecisionAt?: string;
  /** Why the last poll failed, when it did. */
  error?: string;
  lastPollAt?: string;
}

/** A `World` that also answers the status route. */
export interface RemoteWorld extends World {
  status(): RemoteStatus;
  /** Run one poll cycle now. Exposed for tests; the timer calls the same thing. */
  refresh(): Promise<void>;
}

// --- wire shapes, as the engine serializes them (Dates become ISO strings) ---

interface RemoteAgent {
  id: string;
  name: string;
  labels?: string[];
  status?: 'active' | 'frozen';
  wallets?: { chain: string; address: string; mode: string }[];
  createdAt: string;
}

interface RemotePolicy {
  policyId: string;
  version: string;
  default: 'allow' | 'deny';
  appliesTo?: { agents?: string[]; labels?: string[] };
  rules: { id: string; allow?: unknown; deny?: unknown; escalate?: unknown }[];
}

interface RemoteDecision {
  id: string;
  intentId: string;
  intentHash: string;
  outcome: 'allow' | 'deny' | 'escalate';
  matchedRules?: string[];
  reason?: string;
  policyId: string;
  prevHash: string;
  hash: string;
  latencyMs: number;
  decidedAt: string;
}

interface RemoteLiveness {
  agentId: string;
  expectation: { interval: string; note?: string };
  status: 'alive' | 'late' | 'missing' | 'unknown';
  silentMs: number;
  lastSeenAt?: number;
  lastSource?: 'intent' | 'heartbeat';
}

interface RemoteGap {
  intentId: string;
  decisionId?: string;
  agentId: string;
  host: string;
  resource: string;
  amount: string;
  settledAmount?: string;
  allowedAt: number;
  ageMs: number;
  state: 'in-flight' | 'unsettled' | 'overspent';
}

interface RemoteReconciliation {
  window: string;
  graceMs: number;
  allowed: number;
  allowedValue: string;
  settled: number;
  settledValue: string;
  inFlight: number;
  inFlightValue: string;
  unsettled: number;
  unsettledValue: string;
  overspent: number;
  overspentValue: string;
  unattributed: number;
  settlementsSeen: number;
  gaps: RemoteGap[];
}

interface RemoteApproval {
  decisionId: string;
  intentId: string;
  intentHash: string;
  agentId: string;
  vendorHost: string;
  resource: string;
  amount: string;
  reason: string;
  breakers?: string[];
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string;
  expiresAt: string;
  resolvedAt?: string;
  approverKeyId?: string;
  finalDecisionId?: string;
}

interface RemoteBreaker {
  breaker: { id: string; window: string; txCount?: number; valueCap?: string };
  policyId: string;
  txCount: number;
  sum: string;
  countingFrom: number;
  resetAt?: number;
  tripped: boolean;
  reason?: string;
}

/** Empty panels for the three tiers a policy engine has no data for. */
const EMPTY_GATE: GateView = {
  payTo: '',
  network: '',
  quoted: 0,
  settled: 0,
  refused: 0,
  revenue: '0',
  routes: [],
  payers: [],
};
const EMPTY_SIGNER: SignerView = { sessions: [], active: 0 };
const EMPTY_GRAPH: GraphView = {
  subjects: 0,
  vendors: [],
  agents: [],
  syncedCount: 0,
  lastSyncAt: null,
  minConfidence: 0,
  denyBelow: 0,
};

function emptyStats(): Stats {
  return {
    decisions: 0,
    allow: 0,
    deny: 0,
    escalate: 0,
    agents: 0,
    chainLinks: 0,
    revenue: '0',
    quoted: 0,
    gateRefused: 0,
    settled: 0,
    settledValue: '0',
    shadow: 0,
    shadowValue: '0',
    avgLatencyMs: 0,
    sigReleased: 0,
    sigRefused: 0,
  };
}

function emptyReconciliation(at: string): ReconciliationView {
  return {
    window: '24h',
    graceMs: 0,
    allowed: 0,
    allowedValue: '0',
    settled: 0,
    settledValue: '0',
    inFlight: 0,
    inFlightValue: '0',
    unsettled: 0,
    unsettledValue: '0',
    overspent: 0,
    overspentValue: '0',
    unattributed: 0,
    // Zero here is the honesty valve doing its job: a console that has not
    // reached the engine knows of no reporter, and the panel says so rather
    // than implying that settlements are being watched.
    settlementsSeen: 0,
    gaps: [],
    at,
  };
}

function emptyEscalations(at: string): EscalationsView {
  return { approvers: [], ttlMs: 0, pending: [], recent: [], at };
}

/**
 * The console renders a policy's rules as one line each, and the engine
 * publishes the rule objects verbatim — so the summary is built here from the
 * same condition shape the local world reads. Kept as its own copy rather
 * than imported from `world.ts`, which would drag an entire in-process
 * deployment (PGlite, the gate, the signer, the mock chain) into the one
 * module whose whole point is not to have one.
 */
export function summarizeCondition(c: Record<string, unknown> | undefined): string {
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

/**
 * A short, stable fingerprint of the engine's signing key (5.2).
 *
 * Whitespace is stripped before hashing, and that is not tidiness: S60 lost
 * an afternoon to a recipe that hashed CRLF on one machine and LF on another
 * and reported a key mismatch that was never there. What an operator compares
 * must not depend on how the PEM was transported.
 */
export function fingerprintPem(pem: string): string {
  return createHash('sha256').update(pem.replace(/\s+/g, '')).digest('hex').slice(0, 16);
}

export async function createRemoteWorld(options: RemoteWorldOptions): Promise<RemoteWorld> {
  const base = options.engineUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const startedAt = new Date(now()).toISOString();

  const listeners = new Set<(ev: ServerEvent) => void>();
  let feed: FeedItem[] = [];
  let seq = 0;
  let closed = false;

  let agents: AgentView[] = [];
  let policies: PolicyView[] = [];
  let breakers: BreakerView[] = [];
  let reconciliation: ReconciliationView = emptyReconciliation(startedAt);
  let escalations: EscalationsView = emptyEscalations(startedAt);
  let stats: Stats = emptyStats();
  let publicKey = '';
  let status: RemoteStatus = { engine: base, state: 'unreachable' };

  /**
   * Where the decision chain was last read to. `after` is a POSITION in this
   * caller's visible sequence, which the engine guarantees is append-only, so
   * the cursor means the same thing on the next poll as it did on this one.
   * `-1` is "nothing read yet".
   */
  let cursor = -1;
  let chainLength = 0;
  let lastDecisionAt: string | undefined;
  let allowSeen = 0;
  let denySeen = 0;
  let escalateSeen = 0;
  let latencyTotal = 0;
  let latencyCount = 0;

  /** Intent id -> what the reconciliation and escalation views know about it. */
  const intentFacts = new Map<
    string,
    { agentId: string; host: string; resource: string; amount: string }
  >();
  const agentNames = new Map<string, string>();

  function emit(ev: ServerEvent): void {
    for (const l of listeners) {
      try {
        l(ev);
      } catch (err) {
        console.error('[console] remote world listener threw:', err);
      }
    }
  }

  /** Emit only when the rendered value actually changed — SSE is a push, not a poll. */
  function emitChanged<T>(previous: T, next: T, build: (v: T) => ServerEvent): void {
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    emit(build(next));
  }

  async function get<T>(path: string): Promise<{ body: T; headers: Headers }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await doFetch(`${base}${path}`, {
        headers: { Authorization: `Bearer ${options.apiKey}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
      return { body: (await res.json()) as T, headers: res.headers };
    } finally {
      clearTimeout(timer);
    }
  }

  function pushFeed(item: FeedItem): void {
    feed.push(item);
    if (feed.length > FEED_CAP) feed = feed.slice(-FEED_CAP);
    emit({ type: 'feed', item });
  }

  function livenessByAgent(states: RemoteLiveness[]): Map<string, AgentLivenessView> {
    const out = new Map<string, AgentLivenessView>();
    for (const s of states) {
      out.set(s.agentId, {
        interval: s.expectation.interval,
        status: s.status,
        silentMs: s.silentMs,
        ...(s.lastSeenAt !== undefined ? { lastSeenAt: new Date(s.lastSeenAt).toISOString() } : {}),
        ...(s.lastSource !== undefined ? { lastSource: s.lastSource } : {}),
        ...(s.expectation.note !== undefined ? { note: s.expectation.note } : {}),
      });
    }
    return out;
  }

  function viewAgents(raw: RemoteAgent[], live: Map<string, AgentLivenessView>): AgentView[] {
    return raw.map((a): AgentView => {
      const wallet = a.wallets?.[0];
      const liveness = live.get(a.id);
      return {
        id: a.id,
        name: a.name,
        labels: a.labels ?? [],
        // Trusted from the engine, which RESOLVES the kill switch into this
        // field rather than echoing the stored document (see visibleAgents).
        // Before that fix a frozen agent listed as active, and this console
        // has no second source to check it against.
        status: a.status === 'frozen' ? 'frozen' : 'active',
        mode: wallet?.mode ?? 'observed',
        chain: wallet?.chain ?? '—',
        address: wallet?.address ?? '',
        // Rolling spend is the engine's internal ledger and is not published.
        // The reconciliation panel is where allowed value is reported here.
        spent: '0',
        calls: 0,
        createdAt: a.createdAt,
        ...(liveness ? { liveness } : {}),
      };
    });
  }

  function viewEscalation(
    r: RemoteApproval,
    at: number,
    approverNames: Map<string, string>,
  ): EscalationView {
    return {
      decisionId: r.decisionId,
      intentId: r.intentId,
      intentHash: r.intentHash,
      agentId: r.agentId,
      agentName: agentNames.get(r.agentId) ?? r.agentId,
      host: r.vendorHost,
      resource: r.resource,
      amount: r.amount,
      reason: r.reason,
      breakers: r.breakers ?? [],
      status: r.status,
      createdAt: r.createdAt,
      expiresAt: r.expiresAt,
      expiresInMs: Date.parse(r.expiresAt) - at,
      ...(r.resolvedAt ? { resolvedAt: r.resolvedAt } : {}),
      ...(r.approverKeyId
        ? { approverName: approverNames.get(r.approverKeyId) ?? r.approverKeyId }
        : {}),
      ...(r.finalDecisionId !== undefined ? { finalDecisionId: r.finalDecisionId } : {}),
      // No `challenge`. The bytes are derived per request at
      // `/v1/approvals/:decisionId`, and this console cannot submit a verdict
      // anyway — carrying them would invite an operator to sign something the
      // page has nowhere to send.
    };
  }

  /**
   * Read the decisions this console has not seen yet.
   *
   * The first call does NOT start at zero. `Rein-Chain-Length` says how long
   * the visible chain is, so the cursor is placed one feed-seed back from the
   * head: a console attaching to an engine with 40 000 decisions is a
   * dashboard opening, not a backfill job, and replaying that chain into a
   * 300-row feed would cost minutes of requests to show the same last page.
   * The all-time counters come from the header, not from counting rows, so
   * they are right regardless of where the feed starts.
   */
  async function readDecisions(): Promise<RemoteDecision[]> {
    if (cursor < 0) {
      const probe = await get<RemoteDecision[]>('/v1/decisions?limit=1');
      chainLength = Number(probe.headers.get('Rein-Chain-Length') ?? '0');
      cursor = Math.max(-1, chainLength - FEED_SEED - 1);
    }
    const collected: RemoteDecision[] = [];
    // Bounded: at most a few pages per poll, so a burst cannot make one cycle
    // run until the next one is already due.
    for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
      // `cursor` is -1 for "nothing read yet", but that sentinel is ours, not
      // the engine's: `after` is validated nonnegative and the start of the
      // chain is expressed by OMITTING it. Sending -1 is a 400, and only on a
      // chain shorter than FEED_SEED + 1 -- which is every young engine, and
      // no seeded test fixture.
      const res = await get<RemoteDecision[]>(
        cursor < 0 ? '/v1/decisions' : `/v1/decisions?after=${cursor}`,
      );
      chainLength = Number(res.headers.get('Rein-Chain-Length') ?? String(chainLength));
      if (res.body.length === 0) break;
      collected.push(...res.body);
      cursor += res.body.length;
      if (res.headers.get('Rein-Next-After') === null) break;
    }
    for (const d of collected) {
      if (d.outcome === 'allow') allowSeen += 1;
      else if (d.outcome === 'deny') denySeen += 1;
      else escalateSeen += 1;
      latencyTotal += d.latencyMs;
      latencyCount += 1;
      lastDecisionAt = d.decidedAt;
    }
    return collected;
  }

  function buildStats(agentCount: number, recon: ReconciliationView): Stats {
    return {
      // All-time, from the chain itself: `Rein-Chain-Length` is what this key
      // can see in total, the same number the local world reads off its log.
      decisions: chainLength,
      // Outcome splits count only what this process has READ — the seed
      // window plus everything since. A console that attached at decision
      // 40 000 cannot claim the split of the first 39 950 without fetching
      // them, and a plausible-looking guess is worse than a number that is
      // honestly about the window it covers.
      allow: allowSeen,
      deny: denySeen,
      escalate: escalateSeen,
      agents: agentCount,
      chainLinks: chainLength,
      // The vendor-side counters a policy engine has nothing to say about.
      revenue: '0',
      quoted: 0,
      gateRefused: 0,
      // Settlement counters come from the engine's reconciliation, which IS
      // durable and all-time. The local world derives these from a mock
      // ledger it owns, and there is no mock ledger here.
      settled: recon.settled,
      settledValue: recon.settledValue,
      shadow: 0,
      shadowValue: '0',
      avgLatencyMs: latencyCount === 0 ? 0 : Math.round(latencyTotal / latencyCount),
      sigReleased: 0,
      sigRefused: 0,
    };
  }

  /** One poll cycle: read everything, rebuild the views, emit what moved. */
  async function refresh(): Promise<void> {
    const at = now();
    const atIso = new Date(at).toISOString();
    try {
      const health = await get<{ publicKey?: string }>('/health');
      publicKey = health.body.publicKey ?? publicKey;

      const [agentRes, policyRes, livenessRes, reconRes] = await Promise.all([
        get<RemoteAgent[]>('/v1/agents'),
        get<RemotePolicy[]>('/v1/policies'),
        get<RemoteLiveness[]>('/v1/liveness'),
        get<RemoteReconciliation>('/v1/reconciliation'),
      ]);

      agentNames.clear();
      for (const a of agentRes.body) agentNames.set(a.id, a.name);

      const nextAgents = viewAgents(agentRes.body, livenessByAgent(livenessRes.body));
      const nextPolicies = policyRes.body.map(
        (p): PolicyView => ({
          policyId: p.policyId,
          version: p.version,
          default: p.default,
          agents: p.appliesTo?.agents ?? [],
          labels: p.appliesTo?.labels ?? [],
          rules: p.rules.map(summarizeRule),
        }),
      );

      const nextReconciliation: ReconciliationView = {
        window: reconRes.body.window,
        graceMs: reconRes.body.graceMs,
        allowed: reconRes.body.allowed,
        allowedValue: reconRes.body.allowedValue,
        settled: reconRes.body.settled,
        settledValue: reconRes.body.settledValue,
        inFlight: reconRes.body.inFlight,
        inFlightValue: reconRes.body.inFlightValue,
        unsettled: reconRes.body.unsettled,
        unsettledValue: reconRes.body.unsettledValue,
        // An engine older than Sprint 6 sends no overspent fields; a missing
        // count is zero rather than a crashed poll.
        overspent: reconRes.body.overspent ?? 0,
        overspentValue: reconRes.body.overspentValue ?? '0',
        unattributed: reconRes.body.unattributed,
        settlementsSeen: reconRes.body.settlementsSeen,
        gaps: reconRes.body.gaps.map(
          (g): AllowanceGapView => ({
            intentId: g.intentId,
            ...(g.decisionId !== undefined ? { decisionId: g.decisionId } : {}),
            agentId: g.agentId,
            agentName: agentNames.get(g.agentId) ?? g.agentId,
            host: g.host,
            resource: g.resource,
            amount: g.amount,
            ...(g.settledAmount !== undefined ? { settledAmount: g.settledAmount } : {}),
            allowedAt: new Date(g.allowedAt).toISOString(),
            ageMs: g.ageMs,
            state: g.state,
          }),
        ),
        at: atIso,
      };
      // Gaps are one of only two places the engine publishes intent detail,
      // so they are also what lets a decision row name an agent and an amount.
      for (const g of reconRes.body.gaps) {
        intentFacts.set(g.intentId, {
          agentId: g.agentId,
          host: g.host,
          resource: g.resource,
          amount: g.amount,
        });
      }

      // Escalations are optional: an engine with approvals unwired answers
      // 503 here, and that is a configuration, not an outage.
      let nextEscalations = emptyEscalations(atIso);
      try {
        const [approvalRes, approverRes] = await Promise.all([
          get<RemoteApproval[]>('/v1/approvals'),
          get<{ id: string; name: string; revokedAt?: string }[]>('/v1/approvers'),
        ]);
        const approverNames = new Map(approverRes.body.map((k) => [k.id, k.name]));
        for (const r of approvalRes.body) {
          intentFacts.set(r.intentId, {
            agentId: r.agentId,
            host: r.vendorHost,
            resource: r.resource,
            amount: r.amount,
          });
        }
        nextEscalations = {
          approvers: approverRes.body
            .filter((k) => !k.revokedAt)
            .map((k) => ({ id: k.id, name: k.name })),
          // The TTL is the engine's and it is not published. Zero reads as
          // "not stated" in the panel rather than as an expiry of now.
          ttlMs: 0,
          pending: approvalRes.body
            .filter((r) => r.status === 'pending' && Date.parse(r.expiresAt) > at)
            .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
            .map((r) => viewEscalation(r, at, approverNames)),
          recent: approvalRes.body
            .filter((r) => r.status !== 'pending')
            .sort((a, b) => Date.parse(b.resolvedAt ?? '0') - Date.parse(a.resolvedAt ?? '0'))
            .slice(0, ESCALATION_HISTORY)
            .map((r) => viewEscalation(r, at, approverNames)),
          at: atIso,
        };
      } catch (err) {
        console.warn('[console] escalations unavailable from the engine:', err);
      }

      const nextBreakers: BreakerView[] = [];
      for (const a of agentRes.body.slice(0, BREAKER_AGENT_CAP)) {
        try {
          const res = await get<RemoteBreaker[]>(`/v1/agents/${encodeURIComponent(a.id)}/breakers`);
          for (const s of res.body) {
            nextBreakers.push({
              agentId: a.id,
              agentName: a.name,
              breakerId: s.breaker.id,
              policyId: s.policyId,
              window: s.breaker.window,
              ...(s.breaker.txCount !== undefined ? { txCap: s.breaker.txCount } : {}),
              ...(s.breaker.valueCap !== undefined ? { valueCap: s.breaker.valueCap } : {}),
              txCount: s.txCount,
              sum: s.sum,
              countingFrom: new Date(s.countingFrom).toISOString(),
              ...(s.resetAt !== undefined ? { resetAt: new Date(s.resetAt).toISOString() } : {}),
              tripped: s.tripped,
              ...(s.reason !== undefined ? { reason: s.reason } : {}),
            });
          }
        } catch (err) {
          // One agent's breakers failing must not blank the whole panel.
          console.warn(`[console] breakers unavailable for ${a.id}:`, err);
        }
      }

      const fresh = await readDecisions();

      // --- commit, emitting only what moved -------------------------------
      emitChanged(agents, nextAgents, (v) => ({ type: 'agents', agents: v }));
      agents = nextAgents;
      emitChanged(policies, nextPolicies, (v) => ({ type: 'policies', policies: v }));
      policies = nextPolicies;
      emitChanged(breakers, nextBreakers, (v) => ({ type: 'breakers', breakers: v }));
      breakers = nextBreakers;
      emitChanged(reconciliation, nextReconciliation, (v) => ({
        type: 'reconciliation',
        reconciliation: v,
      }));
      reconciliation = nextReconciliation;
      emitChanged(escalations, nextEscalations, (v) => ({ type: 'escalations', escalations: v }));
      escalations = nextEscalations;

      for (const d of fresh) {
        const facts = intentFacts.get(d.intentId);
        pushFeed({
          seq: ++seq,
          at: d.decidedAt,
          kind: 'decision',
          outcome: d.outcome,
          ...(d.reason !== undefined ? { reason: d.reason } : {}),
          matchedRules: d.matchedRules ?? [],
          policyId: d.policyId,
          latencyMs: d.latencyMs,
          decisionId: d.id,
          intentId: d.intentId,
          hash: d.hash,
          prevHash: d.prevHash,
          ...(facts
            ? {
                agentId: facts.agentId,
                agentName: agentNames.get(facts.agentId) ?? facts.agentId,
                host: facts.host,
                resource: facts.resource,
                amount: facts.amount,
              }
            : {}),
        });
      }

      const nextStats = buildStats(nextAgents.length, nextReconciliation);
      emitChanged(stats, nextStats, (v) => ({ type: 'stats', stats: v }));
      stats = nextStats;

      status = {
        engine: base,
        state: 'ok',
        ...(publicKey ? { publicKeyFingerprint: fingerprintPem(publicKey) } : {}),
        ...(lastDecisionAt !== undefined ? { lastDecisionAt } : {}),
        lastPollAt: atIso,
      };
    } catch (err) {
      // A poll failure leaves the LAST GOOD state standing rather than
      // blanking the dashboard: the engine being briefly unreachable is not
      // evidence that its agents went away. `status` is where the staleness
      // is admitted, which is the whole reason 5.2 exists.
      status = {
        engine: base,
        state: 'unreachable',
        ...(publicKey ? { publicKeyFingerprint: fingerprintPem(publicKey) } : {}),
        ...(lastDecisionAt !== undefined ? { lastDecisionAt } : {}),
        error: err instanceof Error ? err.message : String(err),
        lastPollAt: atIso,
      };
    }
  }

  function getState(): ConsoleState {
    return {
      feed: [...feed],
      agents,
      policies,
      stats,
      gate: EMPTY_GATE,
      signer: EMPTY_SIGNER,
      graph: EMPTY_GRAPH,
      breakers,
      reconciliation,
      escalations,
      demo: { running: false, phase: 'idle' },
      publicKey,
      startedAt,
    };
  }

  function subscribe(listener: (ev: ServerEvent) => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // The first poll is awaited so the console serves a populated dashboard on
  // its very first request rather than an empty one that fills in later. It
  // cannot THROW, though: `refresh` swallows transport failures into
  // `status`, because crash-looping a public page over an engine that is
  // briefly down is precisely the failure mode boot.ts exists to avoid.
  await refresh();

  const timer: NodeJS.Timeout = setInterval(() => {
    if (closed) return;
    void refresh();
  }, pollMs);
  timer.unref?.();

  const refuse = async (): Promise<boolean> => false;

  return {
    getState,
    subscribe,
    status: () => status,
    refresh,
    // Every mutation below refuses BY CONSTRUCTION. See the header: this
    // console holds a read key and no authority, so the honest answer is
    // "no", not an attempt the engine would answer 403.
    freeze: refuse,
    unfreeze: refuse,
    pingAgent: refuse,
    submitGrant: () => {
      throw new Error(
        'this console is a read-only client of a hosted engine; submit the signed verdict to the engine directly',
      );
    },
    runDemo: () => false,
    close: async () => {
      closed = true;
      clearInterval(timer);
      listeners.clear();
    },
  };
}
