import type { PGlite } from '@electric-sql/pglite';
import {
  Agent,
  ApprovalRequest,
  ApproverKey,
  LivenessExpectation,
  Policy,
  type LivenessSource,
} from '@reinconsole/core';
import {
  InMemoryAgentRegistry,
  InMemoryApprovalStore,
  InMemoryLivenessStore,
  InMemoryPolicyStore,
  InMemorySettlementStore,
  InMemorySpendStore,
  type AgentRegistryPort,
  type ApprovalStorePort,
  type LivenessRecord,
  type LivenessStorePort,
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

/**
 * Dead-man state (B2). Durable for the same reason the breaker floors are, and
 * then some: a restart that forgot the SIGHTINGS would read every live agent
 * as silent since boot and alarm about the deployment rather than the agents,
 * while one that forgot `alerted_at` would re-announce every death an operator
 * has already been told about. (The engine's witness floor keeps the first
 * failure from paging anyone, but the panel would still be wrong.)
 *
 * Sightings are LATEST-wins — `GREATEST` in SQL — the opposite of a
 * settlement's first-report-wins rule: a settlement is one event that happened
 * once, while a sighting is evidence of ongoing life.
 */
export class PgLivenessStore implements LivenessStorePort {
  private readonly mem = new InMemoryLivenessStore();

  private constructor(private readonly db: PGlite) {}

  static async open(db: PGlite): Promise<PgLivenessStore> {
    const store = new PgLivenessStore(db);
    const rows = await db.query<{
      agent_id: string;
      interval_str: string;
      grace_ms: number | string;
      since_ms: number | string;
      note: string | null;
      last_seen_at: number | string | null;
      last_source: string | null;
      alerted_at: number | string | null;
    }>(
      'SELECT agent_id, interval_str, grace_ms, since_ms, note, last_seen_at, last_source, ' +
        'alerted_at FROM agent_liveness',
    );
    for (const row of rows.rows) {
      store.mem.watch(
        LivenessExpectation.parse({
          agentId: row.agent_id,
          interval: row.interval_str,
          graceMs: Number(row.grace_ms),
          since: new Date(Number(row.since_ms)),
          ...(row.note ? { note: row.note } : {}),
        }),
      );
      if (row.last_seen_at !== null) {
        store.mem.seen(
          row.agent_id,
          Number(row.last_seen_at),
          row.last_source === 'intent' ? 'intent' : 'heartbeat',
        );
      }
      if (row.alerted_at !== null) store.mem.setAlerted(row.agent_id, Number(row.alerted_at));
    }
    return store;
  }

  async watch(expectation: LivenessExpectation): Promise<void> {
    // The sighting columns are untouched by an upsert: editing an interval is
    // a config change, not a claim that the agent just checked in.
    await this.db.query(
      `INSERT INTO agent_liveness (agent_id, interval_str, grace_ms, since_ms, note)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (agent_id) DO UPDATE SET
         interval_str = EXCLUDED.interval_str,
         grace_ms = EXCLUDED.grace_ms,
         note = EXCLUDED.note`,
      [
        expectation.agentId,
        expectation.interval,
        expectation.graceMs,
        expectation.since.getTime(),
        expectation.note ?? null,
      ],
    );
    this.mem.watch(expectation);
  }

  async unwatch(agentId: string): Promise<void> {
    await this.db.query('DELETE FROM agent_liveness WHERE agent_id = $1', [agentId]);
    this.mem.unwatch(agentId);
  }

  get(agentId: string): LivenessRecord | undefined {
    return this.mem.get(agentId);
  }

  list(): LivenessRecord[] {
    return this.mem.list();
  }

  async seen(agentId: string, at: number, source: LivenessSource): Promise<void> {
    await this.db.query(
      `UPDATE agent_liveness
          SET last_seen_at = GREATEST(COALESCE(last_seen_at, 0), $2),
              last_source = CASE WHEN COALESCE(last_seen_at, 0) < $2 THEN $3 ELSE last_source END
        WHERE agent_id = $1`,
      [agentId, at, source],
    );
    this.mem.seen(agentId, at, source);
  }

  async setAlerted(agentId: string, at: number | undefined): Promise<void> {
    await this.db.query('UPDATE agent_liveness SET alerted_at = $2 WHERE agent_id = $1', [
      agentId,
      at ?? null,
    ]);
    this.mem.setAlerted(agentId, at);
  }
}

/**
 * Durable A2 approvals: registered approver keys, and the escalations parked
 * against them.
 *
 * Both writes are persist-then-cache like the signer's, for the same reason —
 * this is authority state, not telemetry. The asymmetry worth naming is what a
 * LOST request would mean. A breaker floor is durable, so a restart resumes
 * with the behavior still tripped; if the parked request vanished with the
 * process, the payment would stay blocked with no challenge left to answer and
 * no record that a human was ever asked. The TTL rides in the doc, so a
 * resumed request keeps its ORIGINAL deadline: a restart must not hand a stale
 * escalation a fresh lease, and one that lapsed while the process was down is
 * swept into its deny on the next sweep, exactly as if nothing had restarted.
 */
export class PgApprovalStore implements ApprovalStorePort {
  private readonly mem = new InMemoryApprovalStore();

  private constructor(private readonly db: PGlite) {}

  static async open(db: PGlite): Promise<PgApprovalStore> {
    const store = new PgApprovalStore(db);
    const keys = await db.query<{ doc: unknown }>('SELECT doc FROM approvers');
    for (const row of keys.rows) store.mem.putApprover(ApproverKey.parse(row.doc));
    const requests = await db.query<{ doc: unknown }>('SELECT doc FROM approval_requests');
    for (const row of requests.rows) store.mem.putRequest(ApprovalRequest.parse(row.doc));
    return store;
  }

  async putApprover(key: ApproverKey): Promise<void> {
    await this.db.query(
      `INSERT INTO approvers (id, doc) VALUES ($1, $2)
       ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc`,
      [key.id, JSON.stringify(key)],
    );
    this.mem.putApprover(key);
  }

  getApprover(id: string): ApproverKey | undefined {
    return this.mem.getApprover(id);
  }

  listApprovers(): ApproverKey[] {
    return this.mem.listApprovers();
  }

  async putRequest(request: ApprovalRequest): Promise<void> {
    await this.db.query(
      `INSERT INTO approval_requests (decision_id, doc) VALUES ($1, $2)
       ON CONFLICT (decision_id) DO UPDATE SET doc = EXCLUDED.doc`,
      [request.decisionId, JSON.stringify(request)],
    );
    this.mem.putRequest(request);
  }

  getRequest(decisionId: string): ApprovalRequest | undefined {
    return this.mem.getRequest(decisionId);
  }

  listRequests(): ApprovalRequest[] {
    return this.mem.listRequests();
  }

  /**
   * Drop resolved requests older than `olderThanMs`. Pending requests are
   * NEVER pruned whatever their age — a lapsed one is still owed its deny on
   * the chain, and the sweep is what produces it. Resolved rows are history
   * whose authoritative copy is the decision chain, so they are the accretion
   * this drains (one row per escalation, forever, otherwise).
   */
  async pruneResolved(olderThanMs: number): Promise<number> {
    const cutoff = Date.now() - olderThanMs;
    let dropped = 0;
    for (const request of this.mem.listRequests()) {
      if (request.status === 'pending') continue;
      if ((request.resolvedAt ?? request.expiresAt).getTime() > cutoff) continue;
      await this.db.query('DELETE FROM approval_requests WHERE decision_id = $1', [
        request.decisionId,
      ]);
      this.mem.dropRequest(request.decisionId);
      dropped += 1;
    }
    return dropped;
  }
}
