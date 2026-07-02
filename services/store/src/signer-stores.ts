import type { PGlite } from '@electric-sql/pglite';
import { Session, sumDecimal } from '@rein/core';
import { InMemorySessionStore, type SessionStorePort } from '@rein/signer';

/**
 * Durable backing for @rein/signer's custody accounting. Persist-then-cache,
 * like the engine stores: every write awaits the database before the working
 * set reflects it — a failed write leaves memory untouched, and an
 * acknowledged revocation, spend record, or voucher burn is on disk. (This is
 * the safety accounting of the custody tier: losing any of it across a
 * restart would resurrect spent authority.)
 *
 * The one deliberate exception is `burnDecision`: its check-and-set runs
 * synchronously at call time — the port contract that makes two concurrent
 * signs racing one voucher safe — with the reservation rolled back if the
 * INSERT then fails. Wallet PRIVATE KEYS are never stored here (KMS/HSM
 * territory); deployments re-register wallets at boot.
 */
export class PgSessionStore implements SessionStorePort {
  private readonly mem = new InMemorySessionStore();

  private constructor(private readonly db: PGlite) {}

  static async open(db: PGlite): Promise<PgSessionStore> {
    const store = new PgSessionStore(db);
    const sessions = await db.query<{ doc: unknown; spent: string }>(
      'SELECT doc, spent FROM signer_sessions ORDER BY seq',
    );
    for (const row of sessions.rows) {
      const session = Session.parse(row.doc);
      store.mem.create(session);
      if (row.spent !== '0') store.mem.recordSpend(session.id, row.spent);
    }
    const used = await db.query<{ decision_id: string }>(
      'SELECT decision_id FROM signer_used_decisions',
    );
    for (const row of used.rows) store.mem.burnDecision(row.decision_id);
    return store;
  }

  async create(session: Session): Promise<void> {
    await this.db.query(
      `INSERT INTO signer_sessions (id, token_hash, spent, doc) VALUES ($1, $2, '0', $3::jsonb)`,
      [session.id, session.tokenHash, JSON.stringify(session)],
    );
    this.mem.create(session);
  }

  async revoke(id: string, at: Date): Promise<void> {
    const current = this.mem.get(id);
    if (!current) throw new Error(`unknown session: ${id}`);
    if (current.revokedAt !== undefined) return; // idempotent, like the working set
    const revoked: Session = { ...current, revokedAt: at };
    await this.db.query('UPDATE signer_sessions SET doc = $2::jsonb WHERE id = $1', [
      id,
      JSON.stringify(revoked),
    ]);
    this.mem.revoke(id, at);
  }

  async recordSpend(id: string, amount: string): Promise<void> {
    const base = this.mem.spent(id);
    const next = sumDecimal([base, amount]);
    // Optimistic guard: the UPDATE lands only if disk still holds the total
    // this write was computed from. The signer serializes its own sign() path
    // (one writer per store — see the port note), so the guard never fires
    // there; if a second writer ever appears, a lost-update would UNDERCOUNT
    // spend on disk and a restart would resurrect spent authority — fail loud
    // instead, with memory untouched.
    const updated = await this.db.query<{ id: string }>(
      'UPDATE signer_sessions SET spent = $2 WHERE id = $1 AND spent = $3 RETURNING id',
      [id, next, base],
    );
    if (updated.rows.length === 0) {
      throw new Error(`concurrent spend write on session ${id} — recordSpend lost the race`);
    }
    this.mem.recordSpend(id, amount);
  }

  burnDecision(decisionId: string): Promise<boolean> {
    // The reservation is SYNC (concurrent signs racing one voucher interleave
    // at awaits — exactly one may pass); the durable write follows, and a
    // failure rolls the reservation back so memory never claims a burn the
    // disk doesn't hold.
    if (!this.mem.burnDecision(decisionId)) return Promise.resolve(false);
    return this.db
      .query('INSERT INTO signer_used_decisions (decision_id) VALUES ($1)', [decisionId])
      .then(
        () => true,
        (err: unknown) => {
          this.mem.unburnDecision(decisionId);
          throw err;
        },
      );
  }

  async unburnDecision(decisionId: string): Promise<void> {
    await this.db.query('DELETE FROM signer_used_decisions WHERE decision_id = $1', [decisionId]);
    this.mem.unburnDecision(decisionId);
  }

  findByTokenHash(hash: string): Session | undefined {
    return this.mem.findByTokenHash(hash);
  }

  get(id: string): Session | undefined {
    return this.mem.get(id);
  }

  list(): readonly Session[] {
    return this.mem.list();
  }

  spent(id: string): string {
    return this.mem.spent(id);
  }

  isDecisionUsed(decisionId: string): boolean {
    return this.mem.isDecisionUsed(decisionId);
  }

  get size(): number {
    return this.mem.list().length;
  }
}
