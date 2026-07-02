import { createHash } from 'node:crypto';
import { Session, sumDecimal } from '@rein/core';

export interface CreateSessionInput {
  agentId: string;
  /** Cumulative ceiling across the session's lifetime. Absent = uncapped. */
  capAmount?: string;
  /** Ceiling per individual signature. Absent = uncapped. */
  maxPerPayment?: string;
  /** Session lifetime. Defaults to one hour. */
  ttlSeconds?: number;
}

export interface CreatedSession {
  session: Session;
  /** The bearer token — returned exactly once; only its hash is stored. */
  token: string;
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A session's standing at a moment in time. */
export type SessionState = 'active' | 'expired' | 'revoked';

export function sessionState(session: Session, nowMs: number): SessionState {
  if (session.revokedAt !== undefined) return 'revoked';
  if (session.expiresAt.getTime() <= nowMs) return 'expired';
  return 'active';
}

export const DEFAULT_TTL_SECONDS = 3600;

/** Sync for in-memory stores; durable stores return a promise the signer awaits. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The signer's storage seam: session grants (hash-keyed — never the token),
 * per-session cumulative spend, and the burned-decision set that makes every
 * voucher single-use. Writes follow persist-then-cache: a durable impl
 * completes persistence BEFORE resolving, and the signer AWAITS every write —
 * a revocation, a spend record, or a decision burn that has been acknowledged
 * is on disk. (This state is the custody tier's safety accounting; losing a
 * revocation or a burn across a restart would resurrect spent authority.)
 * Reads are synchronous from the hydrated working set.
 *
 * Wallet private keys are deliberately NOT part of this port: custody keys at
 * rest are a KMS/HSM concern, so deployments re-register wallets at boot.
 *
 * Note: the signer serializes its cap accounting per INSTANCE — two signers
 * sharing one durable store would reopen the concurrent-cap race (the burn
 * check-and-set stays safe). One signer per store until a multi-writer story.
 */
export interface SessionStorePort {
  /** Persist a newly created session record (token hash only). */
  create(session: Session): MaybePromise<void>;
  /** Stamp revokedAt (idempotent). Throws on an unknown id. Must stamp the
   *  working-set object IN PLACE: callers hold aliases from create()/list(),
   *  and revocation must be observable through them. */
  revoke(id: string, at: Date): MaybePromise<void>;
  /** Add to the session's cumulative signed-for total. */
  recordSpend(id: string, amount: string): MaybePromise<void>;
  /**
   * Check-and-burn a decision id: returns false when already burned. The
   * check-and-set MUST happen synchronously at call time (before any awaits
   * inside the impl) so two concurrent signs racing one voucher cannot both
   * see it fresh; a durable impl then persists the burn before resolving.
   */
  burnDecision(decisionId: string): MaybePromise<boolean>;
  /** Release a burn after a failed signing leg — the voucher stays usable. */
  unburnDecision(decisionId: string): MaybePromise<void>;

  // Sync reads from the working set.
  findByTokenHash(hash: string): Session | undefined;
  get(id: string): Session | undefined;
  list(): readonly Session[];
  /** Cumulative amount this session has released signatures for. */
  spent(id: string): string;
  isDecisionUsed(decisionId: string): boolean;
}

/**
 * In-memory session store — the default, and the working set durable stores
 * hydrate into. Cumulative spend uses the decimal-string helpers (never
 * floats).
 */
export class InMemorySessionStore implements SessionStorePort {
  private readonly byId = new Map<string, Session>();
  private readonly idByTokenHash = new Map<string, string>();
  private readonly spentById = new Map<string, string>();
  private readonly usedDecisions = new Set<string>();

  create(session: Session): void {
    this.byId.set(session.id, session);
    this.idByTokenHash.set(session.tokenHash, session.id);
    if (!this.spentById.has(session.id)) this.spentById.set(session.id, '0');
  }

  revoke(id: string, at: Date): void {
    const session = this.byId.get(id);
    if (!session) throw new Error(`unknown session: ${id}`);
    if (session.revokedAt === undefined) session.revokedAt = at;
  }

  recordSpend(id: string, amount: string): void {
    this.spentById.set(id, sumDecimal([this.spent(id), amount]));
  }

  burnDecision(decisionId: string): boolean {
    if (this.usedDecisions.has(decisionId)) return false;
    this.usedDecisions.add(decisionId);
    return true;
  }

  unburnDecision(decisionId: string): void {
    this.usedDecisions.delete(decisionId);
  }

  findByTokenHash(hash: string): Session | undefined {
    const id = this.idByTokenHash.get(hash);
    return id === undefined ? undefined : this.byId.get(id);
  }

  get(id: string): Session | undefined {
    return this.byId.get(id);
  }

  list(): readonly Session[] {
    return [...this.byId.values()];
  }

  spent(id: string): string {
    return this.spentById.get(id) ?? '0';
  }

  isDecisionUsed(decisionId: string): boolean {
    return this.usedDecisions.has(decisionId);
  }
}
