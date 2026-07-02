import type { PGlite } from '@electric-sql/pglite';
import type { ReputationSubject } from '@rein/core';
import {
  DEFAULT_CORRELATION_LIMIT,
  EvidenceLedger,
  InMemoryIntentStore,
  subjectKey,
  type EvidenceLedgerPort,
  type IntentCorrelationPort,
  type IntentFacts,
} from '@rein/graph';

/**
 * Durable backing for @rein/graph. Unlike the engine stores (persist-then-cache:
 * every write awaits disk before it returns), the graph writes CACHE-THEN-PERSIST:
 * the in-memory working set is updated synchronously and the SQL write trails
 * behind on a serialized queue. The inversion is deliberate — the graph's reads
 * (`score()` / `payerCheck()`) must stay synchronous in the gate hot path, and
 * its writes are driven by an in-process event bus that cannot await a handler.
 * `flush()` drains the queue until it is quiescent (writes enqueued DURING the
 * drain are drained too) and THROWS the first write failure since the last
 * flush — so a clean shutdown, and the HTTP route that awaits it, either is
 * durable or fails loudly. A hard crash loses at most the last unflushed write.
 *
 * Because the aggregate IS the row, every write upserts the whole current row
 * read back from the working set — idempotent and self-healing (a later write
 * for the same subject re-persists the newest value). Settlements touch two
 * subject rows and two edge rows; those four statements run in ONE transaction
 * so a crash cannot tear a settlement (edges are only ever written here, so a
 * torn edge would never self-heal).
 */
export class PgEvidenceLedger implements EvidenceLedgerPort {
  private readonly mem = new EvidenceLedger();
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private failure: unknown;

  private constructor(private readonly db: PGlite) {}

  static async open(db: PGlite): Promise<PgEvidenceLedger> {
    const ledger = new PgEvidenceLedger(db);
    const subjects = await db.query<{
      kind: string;
      id: string;
      first_seen_ms: number | string;
      last_seen_ms: number | string;
      attempts: number | string;
      settled: number | string;
      volume: string;
      shadow_spends: number | string;
      disputes: number | string;
      endorsements: number | string;
      refusals: Record<string, number> | null;
    }>(
      `SELECT kind, id, first_seen_ms, last_seen_ms, attempts, settled, volume,
              shadow_spends, disputes, endorsements, refusals
       FROM graph_subjects`,
    );
    for (const row of subjects.rows) {
      ledger.mem.load({
        subject: { kind: row.kind as ReputationSubject['kind'], id: row.id },
        firstSeenMs: Number(row.first_seen_ms),
        lastSeenMs: Number(row.last_seen_ms),
        attempts: Number(row.attempts),
        settled: Number(row.settled),
        volume: row.volume,
        refusals: row.refusals ?? {},
        shadowSpends: Number(row.shadow_spends),
        disputes: Number(row.disputes),
        endorsements: Number(row.endorsements),
        counterparties: new Map(),
      });
    }
    // Edges are rehydrated after the subjects they hang off — settle() always
    // touches both endpoints, so every subject_key resolves to a loaded record.
    const edges = await db.query<{
      subject_key: string;
      peer_key: string;
      settled: number | string;
      volume: string;
    }>('SELECT subject_key, peer_key, settled, volume FROM graph_counterparties');
    for (const row of edges.rows) {
      const record = ledger.mem.getByKey(row.subject_key);
      if (record) {
        record.counterparties.set(row.peer_key, {
          settled: Number(row.settled),
          volume: row.volume,
        });
      }
    }
    return ledger;
  }

  recordAttempt(subject: ReputationSubject, atMs: number): Promise<void> {
    this.mem.recordAttempt(subject, atMs);
    return this.persistSubject(subject);
  }

  recordSettlement(
    a: ReputationSubject,
    b: ReputationSubject,
    amount: string,
    atMs: number,
  ): Promise<void> {
    this.mem.recordSettlement(a, b, amount, atMs);
    const ka = subjectKey(a);
    const kb = subjectKey(b);
    // One transaction: both endpoints and both edges land together or not at
    // all — edges have no other write path, so a torn edge would silently
    // degrade counterpartyQuality to the lonely-subject 50 forever.
    return this.enqueue(() =>
      this.db.transaction(async (tx) => {
        await this.writeSubject(ka, tx);
        await this.writeSubject(kb, tx);
        await this.writeEdge(ka, kb, tx);
        await this.writeEdge(kb, ka, tx);
      }),
    );
  }

  recordRefusal(subject: ReputationSubject, code: string, atMs: number): Promise<void> {
    this.mem.recordRefusal(subject, code, atMs);
    return this.persistSubject(subject);
  }

  recordShadowSpend(subject: ReputationSubject, atMs: number): Promise<void> {
    this.mem.recordShadowSpend(subject, atMs);
    return this.persistSubject(subject);
  }

  recordDispute(subject: ReputationSubject, atMs: number): Promise<void> {
    this.mem.recordDispute(subject, atMs);
    return this.persistSubject(subject);
  }

  recordEndorsement(subject: ReputationSubject, atMs: number): Promise<void> {
    this.mem.recordEndorsement(subject, atMs);
    return this.persistSubject(subject);
  }

  get(subject: ReputationSubject) {
    return this.mem.get(subject);
  }

  getByKey(key: string) {
    return this.mem.getByKey(key);
  }

  all() {
    return this.mem.all();
  }

  get size(): number {
    return this.mem.size;
  }

  async flush(): Promise<void> {
    await drain(() => this.tail);
    if (this.failed) {
      const err = this.failure;
      this.failed = false;
      this.failure = undefined;
      throw err;
    }
  }

  private persistSubject(subject: ReputationSubject): Promise<void> {
    const key = subjectKey(subject);
    return this.enqueue(() => this.writeSubject(key));
  }

  private async writeSubject(key: string, tx: Queryable = this.db): Promise<void> {
    const ev = this.mem.getByKey(key);
    if (!ev) return;
    await tx.query(
      `INSERT INTO graph_subjects
         (subject_key, kind, id, first_seen_ms, last_seen_ms, attempts, settled,
          volume, shadow_spends, disputes, endorsements, refusals)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb)
       ON CONFLICT (subject_key) DO UPDATE SET
         first_seen_ms = EXCLUDED.first_seen_ms,
         last_seen_ms  = EXCLUDED.last_seen_ms,
         attempts      = EXCLUDED.attempts,
         settled       = EXCLUDED.settled,
         volume        = EXCLUDED.volume,
         shadow_spends = EXCLUDED.shadow_spends,
         disputes      = EXCLUDED.disputes,
         endorsements  = EXCLUDED.endorsements,
         refusals      = EXCLUDED.refusals`,
      [
        key,
        ev.subject.kind,
        ev.subject.id,
        ev.firstSeenMs,
        ev.lastSeenMs,
        ev.attempts,
        ev.settled,
        ev.volume,
        ev.shadowSpends,
        ev.disputes,
        ev.endorsements,
        JSON.stringify(ev.refusals),
      ],
    );
  }

  private async writeEdge(fromKey: string, toKey: string, tx: Queryable = this.db): Promise<void> {
    const line = this.mem.getByKey(fromKey)?.counterparties.get(toKey);
    if (!line) return;
    await tx.query(
      `INSERT INTO graph_counterparties (subject_key, peer_key, settled, volume)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (subject_key, peer_key) DO UPDATE SET
         settled = EXCLUDED.settled,
         volume  = EXCLUDED.volume`,
      [fromKey, toKey, line.settled, line.volume],
    );
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(work);
    // The tail records the FIRST failure for flush() to surface — and swallows
    // the rejection so one failed write cannot wedge the queue. The returned
    // promise still rejects for callers that await the write directly.
    this.tail = next.then(
      () => undefined,
      (err) => {
        if (!this.failed) {
          this.failed = true;
          this.failure = err;
        }
      },
    );
    return next;
  }
}

/**
 * Durable intent correlation map. Same cache-then-persist contract as
 * PgEvidenceLedger: the in-memory bound + FIFO eviction stay authoritative for
 * reads, and the SQL mirror (a small capped table) lets an in-flight intent
 * survive a restart so a `payment.settled` that lands after a crash is still
 * attributed.
 *
 * Known crash-window tear (documented, not defended): consuming an intent and
 * recording its settlement ride two different queues. A hard crash between the
 * two can leave EITHER a consumed intent whose settlement was lost (the replay
 * finds nothing — one settlement undercounted) OR an unconsumed intent whose
 * settlement persisted (a replayed event double-counts once). Both are bounded
 * at one settlement per crash; a cross-store transaction would close it and is
 * queued for the multi-writer store rework.
 */
export class PgIntentStore implements IntentCorrelationPort {
  private readonly mem: InMemoryIntentStore;
  private tail: Promise<void> = Promise.resolve();
  private failed = false;
  private failure: unknown;

  private constructor(
    private readonly db: PGlite,
    private readonly limit: number,
  ) {
    this.mem = new InMemoryIntentStore(limit);
  }

  static async open(db: PGlite, limit: number = DEFAULT_CORRELATION_LIMIT): Promise<PgIntentStore> {
    const store = new PgIntentStore(db, limit);
    const rows = await db.query<{
      intent_id: string;
      agent_id: string;
      host: string;
      amount: string;
    }>('SELECT intent_id, agent_id, host, amount FROM graph_intents ORDER BY seq');
    for (const row of rows.rows) {
      store.mem.remember(row.intent_id, {
        agentId: row.agent_id,
        host: row.host,
        amount: row.amount,
      });
    }
    return store;
  }

  remember(intentId: string, facts: IntentFacts): Promise<void> {
    this.mem.remember(intentId, facts);
    return this.enqueue(async () => {
      await this.db.query(
        `INSERT INTO graph_intents (intent_id, agent_id, host, amount) VALUES ($1, $2, $3, $4)
         ON CONFLICT (intent_id) DO UPDATE SET
           agent_id = EXCLUDED.agent_id, host = EXCLUDED.host, amount = EXCLUDED.amount`,
        [intentId, facts.agentId, facts.host, facts.amount],
      );
      // FIFO bound: keep only the newest `limit` rows, mirroring the in-memory
      // eviction so the table cannot grow unbounded with never-settled intents.
      await this.db.query(
        `DELETE FROM graph_intents WHERE seq IN (
           SELECT seq FROM graph_intents ORDER BY seq DESC OFFSET $1
         )`,
        [this.limit],
      );
    });
  }

  peek(intentId: string): IntentFacts | undefined {
    return this.mem.peek(intentId);
  }

  take(intentId: string): IntentFacts | undefined {
    const facts = this.mem.take(intentId);
    if (facts) {
      void this.enqueue(async () => {
        await this.db.query('DELETE FROM graph_intents WHERE intent_id = $1', [intentId]);
      });
    }
    return facts;
  }

  get size(): number {
    return this.mem.size;
  }

  async flush(): Promise<void> {
    await drain(() => this.tail);
    if (this.failed) {
      const err = this.failure;
      this.failed = false;
      this.failure = undefined;
      throw err;
    }
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    const next = this.tail.then(work);
    // Same failure contract as PgEvidenceLedger.enqueue: record the first
    // failure for flush(), never wedge the queue.
    this.tail = next.then(
      () => undefined,
      (err) => {
        if (!this.failed) {
          this.failed = true;
          this.failure = err;
        }
      },
    );
    return next;
  }
}

/** The slice of PGlite both row writers need — lets one body run on the root
 *  connection or inside a transaction. */
interface Queryable {
  query<T>(query: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

/** Await a moving tail until it is quiescent: writes enqueued while draining
 *  (the bus keeps firing during shutdown) are drained too. */
async function drain(tail: () => Promise<void>): Promise<void> {
  let snapshot: Promise<void>;
  do {
    snapshot = tail();
    await snapshot;
  } while (snapshot !== tail());
}
