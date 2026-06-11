import type { PGlite } from '@electric-sql/pglite';
import { Agent, Policy } from '@rein/core';
import {
  InMemoryAgentRegistry,
  InMemoryPolicyStore,
  InMemorySpendStore,
  type AgentRegistryPort,
  type PolicyStorePort,
  type SpendContext,
  type SpendRecord,
  type SpendStorePort,
} from '@rein/policy-engine';

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
    }>('SELECT agent_id, host, resource, amount, at FROM spend_records ORDER BY seq');
    for (const row of records.rows) {
      store.mem.record({
        agentId: row.agent_id,
        host: row.host,
        resource: row.resource,
        amount: row.amount,
        at: Number(row.at),
      });
    }
    const reputations = await db.query<{ host: string; score: number }>(
      'SELECT host, score FROM vendor_reputation',
    );
    for (const row of reputations.rows) store.mem.setVendorReputation(row.host, row.score);
    return store;
  }

  async record(rec: SpendRecord): Promise<void> {
    await this.db.query(
      'INSERT INTO spend_records (agent_id, host, resource, amount, at) VALUES ($1, $2, $3, $4, $5)',
      [rec.agentId, rec.host, rec.resource, rec.amount, rec.at],
    );
    this.mem.record(rec);
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
}
