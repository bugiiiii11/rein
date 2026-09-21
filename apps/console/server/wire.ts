/**
 * The wire contract between the console server and the React app.
 *
 * Pure types only — no runtime, no node imports — so the browser bundle can
 * `import type` from here with zero leakage. The server normalizes the raw
 * `@reinconsole/core` events into these flat, render-ready shapes.
 */

export type FeedKind =
  | 'intent'
  | 'decision'
  | 'settled'
  | 'shadow'
  // the mirror of a shadow spend: an allowance whose money never moved
  | 'unsettled'
  // the other mirror: an allowance whose money moved, and more of it than allowed
  | 'overspent'
  // dead-man (B2): a watched agent went quiet, and the sighting that ended it
  | 'missing'
  | 'recovered'
  // vendor side (gate.*): a quote issued, revenue earned, a payment turned away
  | 'quote'
  | 'revenue'
  | 'gate-refused'
  // custody tier (signature.*): a key put to work, or refused
  | 'signature'
  | 'sig-refused';
export type Outcome = 'allow' | 'deny' | 'escalate';

/** One row in the live activity feed. */
export interface FeedItem {
  seq: number;
  at: string; // ISO timestamp
  kind: FeedKind;
  agentId?: string;
  agentName?: string;
  amount?: string; // decimal USDC
  host?: string; // vendor host
  resource?: string;
  intentId?: string;
  // decision
  outcome?: Outcome;
  reason?: string;
  matchedRules?: string[];
  policyId?: string;
  latencyMs?: number;
  // audit chain (decisions only)
  decisionId?: string;
  hash?: string;
  prevHash?: string;
  // settlement / shadow
  txHash?: string;
  chain?: string;
  blockNumber?: string; // bigint serialized as string
  // overspent: `amount` is what MOVED; this is the ceiling the decision set
  allowedAmount?: string;
  // gate (vendor side)
  method?: string;
  route?: string;
  payer?: string; // paying wallet address
  // gate / signer refusal code, e.g. "payment_replayed", "decision_replayed"
  code?: string;
  // signer
  sessionId?: string;
  // dead-man (B2): how long the agent had been silent, and what it owes
  silentMs?: number;
  interval?: string;
}

/**
 * Where one agent stands against its expected cadence (B2), flattened onto the
 * agent it describes.
 *
 * It rides {@link AgentView} rather than a panel of its own, for two reasons.
 * Liveness is a property OF an agent — a second top-level list would be a
 * second source of truth for one fact — and the dashboard has no spare
 * vertical space: every fixed panel is paid for out of its column's scroll
 * lists (S43/S44, both measured). An agent nobody watches has no value here
 * at all, which is the "declared, never inferred" rule showing through to the
 * UI: absence means unwatched, not healthy.
 */
export interface AgentLivenessView {
  /** The declared cadence, e.g. '5m'. */
  interval: string;
  /**
   * `alive` | `late` | `missing` | `unknown`. `unknown` is NOT an alarm: the
   * console restarted and has not been up long enough to have witnessed the
   * silence it can see.
   */
  status: 'alive' | 'late' | 'missing' | 'unknown';
  silentMs: number;
  /** ISO; absent when the agent has not been seen once since watching began. */
  lastSeenAt?: string;
  lastSource?: 'intent' | 'heartbeat';
  /** What the agent is supposed to be doing — the alarm's only human context. */
  note?: string;
}

export interface AgentView {
  id: string;
  name: string;
  /** Semantic grouping labels — policy `appliesTo.labels` targets these. */
  labels: string[];
  status: 'active' | 'frozen';
  mode: string; // primary wallet enforcement mode
  chain: string;
  address: string;
  spent: string; // session allowed spend (decimal)
  calls: number; // allowed calls this session
  createdAt: string;
  /** Dead-man state (B2). Absent when nobody is watching this agent. */
  liveness?: AgentLivenessView;
}

export interface PolicyRuleView {
  id: string;
  action: Outcome;
  summary: string;
}

export interface PolicyView {
  policyId: string;
  version: string;
  default: 'allow' | 'deny';
  agents: string[];
  /** Label patterns this policy targets (semantic targeting), if any. */
  labels: string[];
  rules: PolicyRuleView[];
}

/**
 * The headline counters. They come in two windows, and the split is REAL, not
 * cosmetic: on a persistent world (`REIN_CONSOLE_DATA_DIR`) the all-time group
 * is rebuilt from durable state and survives a restart, while the since-boot
 * group is derived from the feed and the mock ledger, which are this process's
 * telemetry. Rendering them side by side unlabelled is what made a resumed
 * console read "0 decisions" next to "11 chain links"; anything added here
 * belongs in one group or the other, deliberately.
 *
 * Not every counter has a durable reading to restore. `avgLatencyMs` measures
 * calls this process made. Shadow spends are detected by reconciling against
 * the mock ledger, which is rebuilt empty each boot. Signer refusals are
 * events, not state. Those are since-boot by nature, not by omission.
 */
export interface Stats {
  // ── all-time: rebuilt from durable state, survives a restart ──────────────
  /** From the signed decision chain — the same source as `chainLinks`. */
  decisions: number;
  allow: number;
  deny: number;
  escalate: number;
  agents: number;
  chainLinks: number;
  // vendor side (the gate fronting the world's API), from persisted receipts
  revenue: string; // decimal USDC the gate has settled
  quoted: number;
  gateRefused: number;

  // ── since this process booted: feed- and mock-ledger-derived ──────────────
  /** Payer-side settlements the indexer confirmed against the mock ledger. */
  settled: number;
  settledValue: string;
  shadow: number;
  shadowValue: string;
  avgLatencyMs: number;
  // custody tier
  sigReleased: number;
  sigRefused: number;
}

export interface GateRouteStat {
  route: string;
  settled: number;
  revenue: string;
}

export interface GatePayerStat {
  payer: string; // lowercased wallet address
  agentName?: string; // resolved when the payer is a managed wallet
  settled: number;
  revenue: string;
}

/** The vendor-side panel: what the world's gated API is earning. */
export interface GateView {
  payTo: string;
  network: string;
  quoted: number;
  settled: number;
  refused: number;
  revenue: string; // decimal USDC
  routes: GateRouteStat[];
  payers: GatePayerStat[];
}

/** One session grant in the signer's custody ledger. */
export interface SignerSessionView {
  id: string;
  agentId: string;
  agentName?: string;
  /** The signer's CURRENT custody address for the agent — session records
   * don't carry wallets, and rotated-out keys are gone by design. */
  wallet: string;
  cap?: string; // decimal cumulative ceiling ('' = uncapped never happens here)
  spent: string; // decimal signed-for total
  status: 'active' | 'expired' | 'revoked';
  /** signature.released count — this process's telemetry, like the feed. */
  burns: number;
  createdAt: string; // ISO
  expiresAt: string; // ISO
}

/** The custody tier: session-key grants and what they've signed for. */
export interface SignerView {
  /** Newest first, so the live grant outranks its revoked ancestors. */
  sessions: SignerSessionView[];
  active: number;
}

/** The five 0–100 reputation components (higher = healthier). `disputeRate`
 * keeps the core field name but stores the INVERTED hygiene value: 100 = clean. */
export interface ReputationComponentsView {
  settlementReliability: number;
  disputeRate: number;
  volume: number;
  counterpartyQuality: number;
  longevity: number;
}

/** One scored subject in the reputation graph, with the evidence behind it. */
export interface ReputationRow {
  kind: 'vendor' | 'agent';
  /** Host (vendors) or erc8004 id / wallet address / agent ULID (agents), normalized. */
  id: string;
  /** Friendly name when one is known (agent name, treasury); else render `id`. */
  label?: string;
  /** Agent row keyed by its on-chain ERC-8004 identity (ULID + wallets fold in). */
  erc8004?: boolean;
  score: number; // 0–100
  confidence: number; // 0–1
  components: ReputationComponentsView;
  // raw evidence, so the panel can explain the score without another endpoint
  attempts: number;
  settled: number;
  volume: string; // settled decimal USDC
  refusals: number; // total across refusal codes
  shadowSpends: number;
  disputes: number;
  endorsements: number;
  firstSeen: string; // ISO
  /** Vendors: this score is currently held by the engine (vendorReputationLt fires). */
  synced: boolean;
  /** Agents: a gate consulting payerCheck would turn this wallet away. */
  barred: boolean;
}

/** The reputation panel: scores recomputed from evidence, never stored. */
export interface GraphView {
  subjects: number;
  vendors: ReputationRow[];
  agents: ReputationRow[];
  syncedCount: number;
  lastSyncAt: string | null; // null until the first syncVendors push
  /** Scores below this confidence are withheld from enforcement (fairness). */
  minConfidence: number;
  /** Both the policy rule's vendorReputationLt and the gate's payer floor. */
  denyBelow: number;
}

/**
 * Where one behavioral breaker stands for one agent, flattened for render.
 *
 * Read-only observability: nothing about evaluation depends on this view, and
 * the counters are measured against a zero-value probe, so `tripped` answers
 * "has the agent already left the envelope?" rather than "would the next
 * payment leave it?". `countingFrom` is the later of the window start and the
 * last signed reset — the floor, which is why a reset needs no counter wipe.
 */
export interface BreakerView {
  agentId: string;
  agentName: string;
  breakerId: string;
  policyId: string;
  window: string; // the trailing span, e.g. '1h'
  /** The tripwires. At least one is always present; both may be. */
  txCap?: number;
  valueCap?: string; // decimal USDC
  // where the agent stands inside the measured span
  txCount: number;
  sum: string; // decimal USDC
  countingFrom: string; // ISO
  /** Present when a signed approval moved the floor. */
  resetAt?: string; // ISO
  tripped: boolean;
  /** Why, when tripped — the same text a human sees in the challenge. */
  reason?: string;
}

/**
 * One allowance the settlement facts disagree with (B1), flattened for render.
 *
 * The mirror image of a shadow spend: a shadow spend is money that moved with
 * no allowance behind it, and this is an allowance with no money behind it —
 * or, for an `overspent` row, with MORE money behind it than it granted.
 * All three are the same join failing, in different directions.
 */
export interface AllowanceGapView {
  intentId: string;
  /** The decision that authorized it — the link into the audit chain. */
  decisionId?: string;
  agentId: string;
  agentName: string;
  host: string;
  resource: string;
  /** The amount ALLOWED. For an overspent row, the ceiling that was crossed. */
  amount: string;
  /** What actually moved, per the settlement reporter. Overspent rows only. */
  settledAmount?: string;
  allowedAt: string; // ISO
  ageMs: number;
  /**
   * `in-flight` is the normal state of any fresh payment; `unsettled` is not;
   * `overspent` is the settlement that exceeded its decision.
   */
  state: 'in-flight' | 'unsettled' | 'overspent';
}

/**
 * The reconciliation panel (B1): where the allowance ledger and the settlement
 * facts disagree.
 *
 * All-time by the two-window rule — every number here is rebuilt from durable
 * state (the spend ledger and the settlements table), so it survives a restart,
 * scoped to the trailing `window` rather than to this process.
 *
 * `settlementsSeen` is the honesty valve. The engine watches no chain; it is
 * TOLD when payments land. Zero reports means nobody is looking, and the gaps
 * below are then an artifact of the wiring, not evidence about payments — the
 * panel must say so rather than raise an alarm it cannot support.
 */
export interface ReconciliationView {
  window: string; // the trailing span of allowances covered, e.g. '24h'
  graceMs: number;
  allowed: number;
  allowedValue: string;
  settled: number;
  settledValue: string;
  inFlight: number;
  inFlightValue: string;
  unsettled: number;
  unsettledValue: string;
  /** Settled for more than allowed; the value is the EXCESS, not the payments. */
  overspent: number;
  overspentValue: string;
  /** Allowances written before B1: no intent id, so nothing to join on. */
  unattributed: number;
  settlementsSeen: number;
  /** Worst first: overspent, then unsettled, then in-flight; oldest before newest. */
  gaps: AllowanceGapView[];
  /** When this report was computed — every `ageMs` is relative to it. */
  at: string; // ISO
}

/**
 * One parked (or lately resolved) escalation, flattened for render.
 *
 * The console shows this and CANNOT answer it, which is the point rather than
 * a limitation: an approval is a signature over `decisionId + intentHash` made
 * by a key the engine has registered, and a dashboard that could turn a click
 * into a verdict would be the click-to-approve path A2 exists to refuse. So
 * the row carries the exact bytes to sign and nothing that would let the page
 * assert anything about them.
 */
export interface EscalationView {
  /** The escalating decision this answers — the link into the audit chain. */
  decisionId: string;
  intentId: string;
  /**
   * What the signature commits to, alongside the decision id. Carried because
   * a submission needs it and it is not a secret — it is on the decision, and
   * without it an operator holding the challenge bytes would have to parse
   * them apart to send one.
   */
  intentHash: string;
  agentId: string;
  agentName: string;
  host: string;
  resource: string;
  amount: string;
  /** Why policy escalated, verbatim from the decision. */
  reason: string;
  /** Breakers whose trip contributed; an approval resets exactly these. */
  breakers: string[];
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  createdAt: string; // ISO
  expiresAt: string; // ISO
  /** Time left before it denies itself. Zero or less: the sweep owes it a deny. */
  expiresInMs: number;
  resolvedAt?: string; // ISO
  /** Who signed. Absent when the TTL lapsed instead — expiry has no author. */
  approverName?: string;
  /** The follow-up decision the resolution appended; the original is untouched. */
  finalDecisionId?: string;
  /** The two byte-strings an approver may sign. Present only while pending. */
  challenge?: { approve: string; reject: string };
}

/**
 * The escalations panel (A2/B3): payments the engine refused to decide alone.
 *
 * `approvers` is the honesty valve, the B3 twin of B1's `settlementsSeen` and
 * B2's `unknown`. A parked escalation with no registered approver key is not a
 * payment awaiting a human — it is a payment nobody can release, which will
 * expire into a deny. The panel says which of the two it is looking at instead
 * of implying that somebody is being asked.
 */
export interface EscalationsView {
  /**
   * Registered, unrevoked approver keys — who could answer, by name. Ids and
   * names only: the public key material is the engine's business, and neither
   * of these is a credential, since a verdict still needs a signature.
   */
  approvers: { id: string; name: string }[];
  /** How long a parked payment stays answerable before it denies. */
  ttlMs: number;
  /** Still answerable, oldest first — the one closest to expiring leads. */
  pending: EscalationView[];
  /** Lately resolved (approved, rejected, or expired), newest first. */
  recent: EscalationView[];
  at: string; // ISO
}

/**
 * What this console will let the caller do (`GET /api/control`), so the UI can
 * render honestly instead of offering buttons that answer 401/403. A public
 * deployment without a key is read-only BY DEFAULT — that is the posture, not
 * a failure to configure.
 */
export interface ControlPosture {
  writable: boolean;
  auth: 'none' | 'bearer';
}

export interface DemoStatus {
  running: boolean;
  phase: string;
}

/** Full snapshot returned by GET /api/state. */
export interface ConsoleState {
  feed: FeedItem[];
  agents: AgentView[];
  policies: PolicyView[];
  stats: Stats;
  gate: GateView;
  signer: SignerView;
  graph: GraphView;
  breakers: BreakerView[];
  reconciliation: ReconciliationView;
  escalations: EscalationsView;
  demo: DemoStatus;
  publicKey: string;
  startedAt: string;
}

/** Messages pushed over the SSE stream. `type` is also the SSE event name. */
export type ServerEvent =
  | { type: 'feed'; item: FeedItem }
  | { type: 'agents'; agents: AgentView[] }
  | { type: 'policies'; policies: PolicyView[] }
  | { type: 'stats'; stats: Stats }
  | { type: 'gate'; gate: GateView }
  | { type: 'signer'; signer: SignerView }
  | { type: 'graph'; graph: GraphView }
  | { type: 'breakers'; breakers: BreakerView[] }
  | { type: 'reconciliation'; reconciliation: ReconciliationView }
  | { type: 'escalations'; escalations: EscalationsView }
  | { type: 'demo'; demo: DemoStatus };
