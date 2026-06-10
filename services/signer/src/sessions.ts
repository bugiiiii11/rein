import { createHash, randomBytes } from 'node:crypto';
import { newId, Session, sumDecimal } from '@rein/core';

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

const DEFAULT_TTL_SECONDS = 3600;

/**
 * In-memory session store. Tokens are random 32-byte secrets looked up by
 * sha256 hash; cumulative spend is tracked per session with the decimal-string
 * helpers (never floats).
 */
export class SessionStore {
  private readonly byId = new Map<string, Session>();
  private readonly idByTokenHash = new Map<string, string>();
  private readonly spentById = new Map<string, string>();

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(input: CreateSessionInput): CreatedSession {
    const token = randomBytes(32).toString('hex');
    const createdAt = new Date(this.now());
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const session = Session.parse({
      id: newId('ses'),
      agentId: input.agentId,
      tokenHash: hashToken(token),
      capAmount: input.capAmount,
      maxPerPayment: input.maxPerPayment,
      expiresAt: new Date(createdAt.getTime() + ttl * 1000),
      createdAt,
    });
    this.byId.set(session.id, session);
    this.idByTokenHash.set(session.tokenHash, session.id);
    this.spentById.set(session.id, '0');
    return { session, token };
  }

  findByToken(token: string): Session | undefined {
    const id = this.idByTokenHash.get(hashToken(token));
    return id === undefined ? undefined : this.byId.get(id);
  }

  get(id: string): Session | undefined {
    return this.byId.get(id);
  }

  revoke(id: string): void {
    const session = this.byId.get(id);
    if (!session) throw new Error(`unknown session: ${id}`);
    if (session.revokedAt === undefined) session.revokedAt = new Date(this.now());
  }

  list(): readonly Session[] {
    return [...this.byId.values()];
  }

  /** Cumulative amount this session has released signatures for. */
  spent(id: string): string {
    return this.spentById.get(id) ?? '0';
  }

  recordSpend(id: string, amount: string): void {
    this.spentById.set(id, sumDecimal([this.spent(id), amount]));
  }
}
