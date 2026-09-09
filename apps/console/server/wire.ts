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
  // gate (vendor side)
  method?: string;
  route?: string;
  payer?: string; // paying wallet address
  // gate / signer refusal code, e.g. "payment_replayed", "decision_replayed"
  code?: string;
  // signer
  sessionId?: string;
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
  | { type: 'demo'; demo: DemoStatus };
