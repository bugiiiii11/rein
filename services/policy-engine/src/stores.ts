import { type Agent, type Policy, type Window, sumDecimal, compareDecimal } from '@reinconsole/core';
import { policyApplies, type BreakerWindow, type SpendContext } from './evaluator.js';

/**
 * One observed/pending spend event. The lightweight in-memory stores here
 * implement the ports the engine depends on; @reinconsole/store swaps in
 * Postgres-backed implementations without touching the engine.
 */
export interface SpendRecord {
  agentId: string;
  host: string;
  resource: string;
  amount: string;
  at: number; // epoch ms
  /** Task attribution, when the caller supplied one. Feeds `taskBudget`. */
  taskId?: string;
  /**
   * The intent this allowance authorized, and the decision that authorized it.
   * Optional because records written before reconciliation (B1) existed carry
   * neither — and a record with no intent id cannot be joined against a
   * settlement, so it is reported as UNATTRIBUTED rather than as a gap. An
   * upgrade must not manufacture alarms out of history it cannot check.
   */
  intentId?: string;
  decisionId?: string;
}

export type MaybePromise<T> = T | Promise<T>;

/**
 * The persistence seams the engine depends on. Writes may be asynchronous (a
 * durable store awaits them before returning, so nothing the engine acted on
 * can be lost); reads are synchronous from the store's hydrated working set,
 * which keeps the hot evaluate path and console state snapshots simple.
 */
export interface SpendStorePort {
  record(rec: SpendRecord): MaybePromise<void>;
  setVendorReputation(host: string, score: number): MaybePromise<void>;
  /**
   * Move a breaker's counting floor for one agent. Called when a signed
   * approval clears a tripped breaker; the floor also expires naturally as
   * the breaker's window rolls past it, so nothing has to be cleaned up.
   */
  resetBreaker(agentId: string, breakerId: string, at: number): MaybePromise<void>;
  /** Where each of an agent's breakers is currently counting from. */
  breakerResets(agentId: string): Record<string, number>;
  /** Resolve a point-in-time spend context for one agent (prior activity only). */
  contextFor(agentId: string, now?: number): SpendContext;
  /**
   * The raw ledger in a span, oldest first — what reconciliation joins against
   * settlements. Every spend record IS an allowance: the engine writes one only
   * after a decision came back `allow` (including the follow-up allow a signed
   * approval appends), so "the allowances made between t0 and t1" needs no
   * separate table to answer.
   */
  allowancesIn(from: number, to?: number): readonly SpendRecord[];
}

/**
 * One settlement fact: an allowed intent whose payment was observed to land.
 * Keyed by intent, because the intent is the payment — a resolved escalation
 * appends a SECOND decision for the same intent (S40), and one settlement
 * settles it however many decisions judged it.
 */
export interface SettlementRecord {
  intentId: string;
  /** Epoch ms the settlement was confirmed at (not when it was reported). */
  at: number;
  txHash?: string;
  chain?: string;
  /** The amount as settled, when the observer knew it. */
  amount?: string;
  /** Who observed it, e.g. "indexer" | "guard" | "facilitator". */
  source?: string;
}

/**
 * Where settlement facts live. Separate from spend on purpose: the engine
 * WRITES an allowance itself, but it can only ever be TOLD about a settlement
 * — it does not watch a chain. A deployment with no reporter has an empty
 * store, which is why the reconciliation report carries `settlementsSeen`:
 * zero means nobody is looking, not that nothing settled.
 */
export interface SettlementStorePort {
  /**
   * Record a settlement. Idempotent by intent id, and the EARLIEST
   * confirmation wins regardless of which report arrived first: a settlement
   * can be observed twice (the paying guard and an indexer both see it), and
   * the earliest confirmation is the one that happened. Arrival order is the
   * property least worth depending on -- the guard reports its local clock as
   * it pays, an indexer reports the chain's timestamp later -- so a report
   * that arrives second with an earlier `at` REPLACES the record, whole, and
   * a report with a later or equal `at` changes nothing. Every store must
   * give the same answer live and after a restart.
   */
  settle(rec: SettlementRecord): MaybePromise<void>;
  get(intentId: string): SettlementRecord | undefined;
  /** How many settlements this engine has ever been told about. */
  count(): number;
}

export interface PolicyStorePort {
  /** Upsert by policyId; an updated policy moves to the END of evaluation order. */
  add(policy: Policy): MaybePromise<void>;
  list(): Policy[];
  get(policyId: string): Policy | undefined;
}

export interface AgentRegistryPort {
  register(agent: Agent): MaybePromise<void>;
  get(id: string): Agent | undefined;
  list(): Agent[];
  freeze(id: string): MaybePromise<void>;
  unfreeze(id: string): MaybePromise<void>;
  isFrozen(id: string): boolean;
}

const WINDOW_MS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

export function parseWindowMs(window: Window): number {
  const match = /^(\d+)([smhd])$/.exec(window);
  if (!match) throw new TypeError(`invalid window: ${window}`);
  const unit = WINDOW_MS[match[2] as string];
  return Number(match[1]) * (unit ?? 0);
}

function within(records: readonly SpendRecord[], window: Window, now: number): SpendRecord[] {
  const cutoff = now - parseWindowMs(window);
  return records.filter((r) => r.at >= cutoff);
}

/** Approximate median (upper-median for even counts; division-free). */
function median(values: readonly string[]): string | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort(compareDecimal);
  return sorted[Math.floor(sorted.length / 2)];
}

export class InMemorySpendStore implements SpendStorePort {
  private readonly records: SpendRecord[] = [];
  private readonly reputations = new Map<string, number>();
  /** agentId -> breakerId -> epoch ms that breaker counts from. */
  private readonly resets = new Map<string, Map<string, number>>();

  record(rec: SpendRecord): void {
    this.records.push(rec);
  }

  setVendorReputation(host: string, score: number): void {
    this.reputations.set(host, score);
  }

  resetBreaker(agentId: string, breakerId: string, at: number): void {
    let mine = this.resets.get(agentId);
    if (!mine) this.resets.set(agentId, (mine = new Map()));
    mine.set(breakerId, at);
  }

  breakerResets(agentId: string): Record<string, number> {
    return Object.fromEntries(this.resets.get(agentId) ?? []);
  }

  /** Resolve a point-in-time spend context for one agent (prior activity only). */
  contextFor(agentId: string, now: number = Date.now()): SpendContext {
    const mine = this.records.filter((r) => r.agentId === agentId);
    const reputations = this.reputations;
    const all = this.records;
    const resets = this.resets;
    return {
      rollingSum: (window) => sumDecimal(within(mine, window, now).map((r) => r.amount)),
      txCount: (window) => within(mine, window, now).length,
      taskSum: (taskId) => sumDecimal(mine.filter((r) => r.taskId === taskId).map((r) => r.amount)),
      breakerWindow: (breakerId, window): BreakerWindow => {
        // The later of the two cutoffs wins, which is the whole trick: a
        // reset and an expiring window are the same operation on the floor.
        const reset = resets.get(agentId)?.get(breakerId) ?? 0;
        const cutoff = Math.max(now - parseWindowMs(window), reset);
        const counted = mine.filter((r) => r.at >= cutoff);
        return { txCount: counted.length, sum: sumDecimal(counted.map((r) => r.amount)) };
      },
      isVendorFirstSeen: (host) => !mine.some((r) => r.host === host),
      vendorReputation: (host) => reputations.get(host),
      resourceMedian: (resource) =>
        median(all.filter((r) => r.resource === resource).map((r) => r.amount)),
    };
  }

  allowancesIn(from: number, to: number = Number.POSITIVE_INFINITY): readonly SpendRecord[] {
    return this.records.filter((r) => r.at >= from && r.at <= to);
  }
}

export class InMemorySettlementStore implements SettlementStorePort {
  private readonly byIntent = new Map<string, SettlementRecord>();

  settle(rec: SettlementRecord): void {
    const seen = this.byIntent.get(rec.intentId);
    // Earliest confirmation wins (see the port). A second observer with a
    // later or equal time adds nothing; an earlier one is the confirmation
    // that actually happened, and replaces the record whole.
    if (seen && seen.at <= rec.at) return;
    this.byIntent.set(rec.intentId, rec);
  }

  get(intentId: string): SettlementRecord | undefined {
    return this.byIntent.get(intentId);
  }

  count(): number {
    return this.byIntent.size;
  }
}

export class InMemoryPolicyStore implements PolicyStorePort {
  private policies: Policy[] = [];

  /** Upsert by policyId (a new version replaces the prior one). */
  add(policy: Policy): void {
    this.policies = this.policies.filter((p) => p.policyId !== policy.policyId);
    this.policies.push(policy);
  }

  list(): Policy[] {
    return this.policies;
  }

  get(policyId: string): Policy | undefined {
    return this.policies.find((p) => p.policyId === policyId);
  }

  applicableFor(
    intent: Parameters<typeof policyApplies>[1],
    agent?: Parameters<typeof policyApplies>[2],
  ): Policy[] {
    return this.policies.filter((p) => policyApplies(p, intent, agent));
  }
}

export class InMemoryAgentRegistry implements AgentRegistryPort {
  private readonly agents = new Map<string, Agent>();
  private readonly frozen = new Set<string>();

  register(agent: Agent): void {
    this.agents.set(agent.id, agent);
    if (agent.status === 'frozen') this.frozen.add(agent.id);
  }

  get(id: string): Agent | undefined {
    return this.agents.get(id);
  }

  list(): Agent[] {
    return [...this.agents.values()];
  }

  freeze(id: string): void {
    this.frozen.add(id);
  }

  unfreeze(id: string): void {
    this.frozen.delete(id);
  }

  isFrozen(id: string): boolean {
    return this.frozen.has(id);
  }
}
