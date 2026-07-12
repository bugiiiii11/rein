import { type Agent, type Policy, type Window, sumDecimal, compareDecimal } from '@reinconsole/core';
import { policyApplies, type SpendContext } from './evaluator.js';

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
  /** Resolve a point-in-time spend context for one agent (prior activity only). */
  contextFor(agentId: string, now?: number): SpendContext;
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

  record(rec: SpendRecord): void {
    this.records.push(rec);
  }

  setVendorReputation(host: string, score: number): void {
    this.reputations.set(host, score);
  }

  /** Resolve a point-in-time spend context for one agent (prior activity only). */
  contextFor(agentId: string, now: number = Date.now()): SpendContext {
    const mine = this.records.filter((r) => r.agentId === agentId);
    const reputations = this.reputations;
    const all = this.records;
    return {
      rollingSum: (window) => sumDecimal(within(mine, window, now).map((r) => r.amount)),
      txCount: (window) => within(mine, window, now).length,
      isVendorFirstSeen: (host) => !mine.some((r) => r.host === host),
      vendorReputation: (host) => reputations.get(host),
      resourceMedian: (resource) =>
        median(all.filter((r) => r.resource === resource).map((r) => r.amount)),
    };
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
