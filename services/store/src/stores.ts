import type { PGlite } from '@electric-sql/pglite';
import { Agent, Policy } from '@reinconsole/core';
import {
  InMemoryAgentRegistry,
  InMemoryPolicyStore,
  InMemorySettlementStore,
  InMemorySpendStore,
  type AgentRegistryPort,
  type PolicyStorePort,
  type SettlementRecord,
  type SettlementStorePort,
  type SpendContext,
  type SpendRecord,
  type SpendStorePort,
} from '@reinconsole/policy-engine';

/**
 * Each Pg store is a write-through pair: the database is the system of record
 * (every write is awaited before it returns), and an in-memory store — the
 * exact same class the engine uses standalone — is the hydrated working set
 * that serves the synchronous reads. Persist-then-cache ordering means a
 * failed write leaves memory untouched.
 */

export class PgAgentRegistry implements AgentRegistryPort {
  private readonly mem = new InMemoryAgentRegistry();

  private constructor(private readonly db: PGlite) {}

  static async open(db: PGlite): Promise<PgAgentRegistry> {
    const registry = new PgAgentRegistry(db);
    const agents = await db.query<{ doc: unknown }>('SELECT doc FROM agents ORDER BY seq');
    for (const row of agents.rows) registry.mem.register(Agent.parse(row.doc));
    const frozen = await db.query<{ id: string }>('SELECT id FROM frozen_agents');
    for (const row of frozen.rows) registry.mem.freeze(row.id);
    return registry;
  }

  async register(agent: Agent): Promise<void> {
    await this.db.query(
      `INSERT INTO agents (id, doc) VALUES ($1, $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`,
      [agent.id, JSON.stringify(agent)],
    );
    if (agent.status === 'frozen') {
      await this.db.query(
        'INSERT INTO frozen_agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING',
        [agent.id],
      );
    }
    this.mem.register(agent);
  }

  get(id: string): Agent | undefined {
    return this.mem.get(id);
  }

  list(): Agent[] {
    return this.mem.list();
  }

  async freeze(id: string): Promise<void> {
    await this.db.query('INSERT INTO frozen_agents (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [
      id,
    ]);
    this.mem.freeze(id);
  }

  async unfreeze(id: string): Promise<void> {
    await this.db.query('DELETE FROM frozen_agents WHERE id = $1', [id]);
    this.mem.unfreeze(id);
  }

  isFrozen(id: string): boolean {
    return this.mem.isFrozen(id);
  }
}

export class PgPolicyStore implements PolicyStorePort {
  private readonly mem = new InMemoryPolicyStore();

  private constructor(private readonly db: PGlite) {}

  static async open(db: PGlite): Promise<PgPolicyStore> {
    const store = new PgPolicyStore(db);
    const policies = await db.query<{ doc: unknown }>('SELECT doc FROM policies ORDER BY seq');
    for (const row of policies.rows) store.mem.add(Policy.parse(row.doc));
    return store;
  }

  async add(policy: Policy): Promise<void> {
    // Mirrors InMemoryPolicyStore: an upsert moves the policy to the END of
    // the first-applicable-wins evaluation order.
    await this.db.query(
      `INSERT INTO policies (policy_id, seq, doc)
       VALUES ($1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM policies), $2::jsonb)
       ON CONFLICT (policy_id) DO UPDATE SET seq = EXCLUDED.seq, doc = EXCLUDED.doc`,
      [policy.policyId, JSON.stringify(policy)],
    );
    this.mem.add(policy);
  }

  list(): Policy[] {
    return this.mem.list();
  }

  get(policyId: string): Policy | undefined {
    return this.mem.get(policyId);
  }
}

export class PgSpendStore implements SpendStorePort {
  private readonly mem = new InMemorySpendStore();

  private constructor(private readonly db: PGlite) {}

  static async open(db: PGlite): Promise<PgSpendStore> {
    const store = new PgSpendStore(db);
    // The whole history hydrates: resourceMedian is all-time by design, so a
    // lookback cutoff would silently change evaluations. Revisit when spend
    // volume outgrows a single process (the same threshold at which these
    // queries move into SQL aggregates).
    const records = await db.query<{
      agent_id: string;
      host: string;
      resource: string;
      amount: string;
      at: number | string;
      task_id: string | null;
      intent_id: string | null;
      decision_id: string | null;
    }>(
      'SELECT agent_id, host, resource, amount, at, task_id, intent_id, decision_id ' +
        'FROM spend_records ORDER BY seq',
    );
    for (const row of records.rows) {
      store.mem.record({
        agentId: row.agent_id,
        host: row.host,
        resource: row.resource,
        amount: row.amount,
        at: Number(row.at),
        ...(row.task_id ? { taskId: row.task_id } : {}),
        // NULL on rows written before B1 — deliberately left undefined rather
        // than backfilled, so reconciliation can tell "no settlement" from
        // "nothing to join on" (see reconciliation.ts).
        ...(row.intent_id ? { intentId: row.intent_id } : {}),
        ...(row.decision_id ? { decisionId: row.decision_id } : {}),
      });
    }
    // Breaker floors hydrate too: without them a restart re-trips every
    // breaker a human had already signed off on.
    const resets = await store.db.query<{
      agent_id: string;
      breaker_id: string;
      at: number | string;
    }>('SELECT agent_id, breaker_id, at FROM breaker_resets');
    for (const row of resets.rows) {
      store.mem.resetBreaker(row.agent_id, row.breaker_id, Number(row.at));
    }
    const reputations = await db.query<{ host: string; score: number }>(
      'SELECT host, score FROM vendor_reputation',
    );
    for (const row of reputations.rows) store.mem.setVendorReputation(row.host, row.score);
    return store;
  }

  async record(rec: SpendRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO spend_records
         (agent_id, host, resource, amount, at, task_id, intent_id, decision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        rec.agentId,
        rec.host,
        rec.resource,
        rec.amount,
        rec.at,
        rec.taskId ?? null,
        rec.intentId ?? null,
        rec.decisionId ?? null,
      ],
    );
    this.mem.record(rec);
  }

  async resetBreaker(agentId: string, breakerId: string, at: number): Promise<void> {
    await this.db.query(
      `INSERT INTO breaker_resets (agent_id, breaker_id, at) VALUES ($1, $2, $3)
       ON CONFLICT (agent_id, breaker_id) DO UPDATE SET at = EXCLUDED.at`,
      [agentId, breakerId, at],
    );
    this.mem.resetBreaker(agentId, breakerId, at);
  }

  breakerResets(agentId: string): Record<string, number> {
    return this.mem.breakerResets(agentId);
  }

  async setVendorReputation(host: string, score: number): Promise<void> {
    await this.db.query(
      `INSERT INTO vendor_reputation (host, score) VALUES ($1, $2)
       ON CONFLICT (host) DO UPDATE SET score = EXCLUDED.score`,
      [host, score],
    );
    this.mem.setVendorReputation(host, score);
  }

  contextFor(agentId: string, now?: number): SpendContext {
    return this.mem.contextFor(agentId, now);
  }

  allowancesIn(from: number, to?: number): readonly SpendRecord[] {
    return this.mem.allowancesIn(from, to);
  }
}

/**
 * Settlement facts (B1). Durable for the same reason the breaker floors are:
 * a restart that forgot them would read every resumed allowance as unsettled
 * and raise an alarm about payments that landed days ago.
 *
 * `INSERT ... ON CONFLICT DO NOTHING` is the first-report-wins rule of
 * {@link SettlementStorePort} expressed in SQL — two observers of one payment
 * cannot fight over its confirmation time.
 */
export class PgSettlementStore implements SettlementStorePort {
  private readonly mem = new InMemorySettlementStore();

  private constructor(private readonly db: PGlite) {}

  static async open(db: PGlite): Promise<PgSettlementStore> {
    const store = new PgSettlementStore(db);
    const rows = await db.query<{
      intent_id: string;
      at: number | string;
      tx_hash: string | null;
      chain: string | null;
      amount: string | null;
      source: string | null;
    }>('SELECT intent_id, at, tx_hash, chain, amount, source FROM settlements');
    for (const row of rows.rows) {
      store.mem.settle({
        intentId: row.intent_id,
        at: Number(row.at),
        ...(row.tx_hash ? { txHash: row.tx_hash } : {}),
        ...(row.chain ? { chain: row.chain } : {}),
        ...(row.amount ? { amount: row.amount } : {}),
        ...(row.source ? { source: row.source } : {}),
      });
    }
    return store;
  }

  async settle(rec: SettlementRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO settlements (intent_id, at, tx_hash, chain, amount, source)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (intent_id) DO NOTHING`,
      [rec.intentId, rec.at, rec.txHash ?? null, rec.chain ?? null, rec.amount ?? null, rec.source ?? null],
    );
    this.mem.settle(rec);
  }

  get(intentId: string): SettlementRecord | undefined {
    return this.mem.get(intentId);
  }

  count(): number {
    return this.mem.count();
  }
}
