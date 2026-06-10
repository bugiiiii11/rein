/**
 * The wire contract between the console server and the React app.
 *
 * Pure types only — no runtime, no node imports — so the browser bundle can
 * `import type` from here with zero leakage. The server normalizes the raw
 * `@rein/core` events into these flat, render-ready shapes.
 */

export type FeedKind = 'intent' | 'decision' | 'settled' | 'shadow';
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
  | { type: 'demo'; demo: DemoStatus };
