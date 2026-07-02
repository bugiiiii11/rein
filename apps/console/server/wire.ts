/**
 * The wire contract between the console server and the React app.
 *
 * Pure types only — no runtime, no node imports — so the browser bundle can
 * `import type` from here with zero leakage. The server normalizes the raw
 * `@rein/core` events into these flat, render-ready shapes.
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
  rules: PolicyRuleView[];
}

export interface Stats {
  decisions: number;
  allow: number;
  deny: number;
  escalate: number;
  settled: number;
  shadow: number;
  settledValue: string;
  shadowValue: string;
  agents: number;
  chainLinks: number;
  avgLatencyMs: number;
  // vendor side (the gate fronting the world's API)
  revenue: string; // decimal USDC the gate has settled
  quoted: number;
  gateRefused: number;
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
  graph: GraphView;
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
  | { type: 'graph'; graph: GraphView }
  | { type: 'demo'; demo: DemoStatus };
