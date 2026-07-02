import type { PGlite } from '@electric-sql/pglite';
import { GateReceipt } from '@rein/core';
import { InMemoryGateStore, type GateStorePort } from '@rein/gate';
import { WriteTail } from './tail.js';

/**
 * Durable backing for @rein/gate. Split consistency, mirroring the port's
 * contract:
 *
 * - `burnReplay` is persist-then-cache SECURITY state: the sync check-and-set
 *   reserves the slot (concurrent copies of one header cannot both pass),
 *   then the INSERT is awaited — the gate settles a payment only after its
 *   slot is durably burned, so a crash-and-restart cannot double-settle. A
 *   failed INSERT rolls the reservation back and escapes as a non-GateError
 *   (the gate answers 500 rather than settle unprotected).
 * - Receipts and counters are cache-then-persist TELEMETRY on a serialized
 *   {@link WriteTail}: the working set updates sync (stats stay hot-path
 *   sync), SQL trails, and `flush()` drains + throws the first failure.
 *   Counters upsert the whole current row — idempotent and self-healing.
 */
export class PgGateStore implements GateStorePort {
  private readonly mem = new InMemoryGateStore();
  private readonly tail = new WriteTail();

  private constructor(private readonly db: PGlite) {}

  static async open(db: PGlite): Promise<PgGateStore> {
    const store = new PgGateStore(db);
    const receipts = await db.query<{ doc: unknown }>('SELECT doc FROM gate_receipts ORDER BY seq');
    for (const row of receipts.rows) store.mem.appendReceipt(GateReceipt.parse(row.doc));
    const replays = await db.query<{ key: string }>('SELECT key FROM gate_replays');
    for (const row of replays.rows) store.mem.burnReplay(row.key);
    const counters = await db.query<{ quoted: number | string; refused: number | string }>(
      `SELECT quoted, refused FROM gate_counters WHERE id = 'gate'`,
    );
    const row = counters.rows[0];
    if (row) store.mem.loadCounters(Number(row.quoted), Number(row.refused));
    return store;
  }

  burnReplay(key: string): Promise<boolean> {
    if (!this.mem.burnReplay(key)) return Promise.resolve(false);
    // Known benign race: a concurrent copy of this header is refused as
    // `payment_replayed` while this INSERT is in flight; if the INSERT then
    // FAILS, the slot is released and neither copy settled — the refusal was
    // "false", but fail-safe (either party may re-present and succeed).
    return this.db.query('INSERT INTO gate_replays (key) VALUES ($1)', [key]).then(
      () => true,
      (err: unknown) => {
        this.mem.releaseReplay(key);
        throw err;
      },
    );
  }

  appendReceipt(receipt: GateReceipt): Promise<void> {
    this.mem.appendReceipt(receipt);
    return this.tail.enqueue(async () => {
      await this.db.query('INSERT INTO gate_receipts (id, doc) VALUES ($1, $2::jsonb)', [
        receipt.id,
        JSON.stringify(receipt),
      ]);
    });
  }

  recordQuote(): Promise<void> {
    this.mem.recordQuote();
    return this.persistCounters();
  }

  recordRefusal(): Promise<void> {
    this.mem.recordRefusal();
    return this.persistCounters();
  }

  receipts(): readonly GateReceipt[] {
    return this.mem.receipts();
  }

  quoted(): number {
    return this.mem.quoted();
  }

  refused(): number {
    return this.mem.refused();
  }

  flush(): Promise<void> {
    return this.tail.flush();
  }

  private persistCounters(): Promise<void> {
    // Whole-row upsert from the working set's CURRENT totals — a later write
    // for the same row re-persists the newest value (idempotent/self-healing).
    const quoted = this.mem.quoted();
    const refused = this.mem.refused();
    return this.tail.enqueue(async () => {
      await this.db.query(
        `INSERT INTO gate_counters (id, quoted, refused) VALUES ('gate', $1, $2)
         ON CONFLICT (id) DO UPDATE SET quoted = EXCLUDED.quoted, refused = EXCLUDED.refused`,
        [quoted, refused],
      );
    });
  }
}
