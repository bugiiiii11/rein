import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiKeyRecord, toPublicApiKey, type ApiKey, type ApiKeyScope } from './api-key.js';
import { newId } from './ulid.js';

/**
 * API-key authentication for a Rein service's HTTP surface.
 *
 * Secrets are never stored: a service keeps sha256 digests, so a leaked
 * database yields nothing that authenticates. A secret is returned exactly
 * once, at issuance. Rotation mints a new secret while keeping the outgoing
 * digest valid for a grace window, so a fleet rolls over without a flag-day
 * restart.
 *
 * This lives in core, beside the {@link ApiKeyRecord} schema it reads and
 * writes, because three services need the SAME answer to "who is calling and
 * may they do this" — the engine, the signer's admin surface, and the graph's
 * ingestion routes. Two implementations of authentication is two things to get
 * wrong. It is reached as `@reinconsole/core/auth` rather than through the
 * package barrel ON PURPOSE: the barrel is imported by the console's BROWSER
 * bundle, and every symbol below needs `node:crypto`.
 */

/** A port may answer synchronously (in memory) or not (durable). */
export type MaybePromise<T> = T | Promise<T>;

/** The presented-secret prefix, so a leaked key is greppable in logs and repos. */
const SECRET_PREFIX = 'rk_';

/** How often a key's `lastUsedAt` is written through. Telemetry, not authority. */
const TOUCH_INTERVAL_MS = 60_000;

/** Default rotation overlap: long enough to redeploy, short enough to matter. */
export const DEFAULT_ROTATION_GRACE_MS = 3_600_000; // 1h

export function mintSecret(): string {
  return SECRET_PREFIX + randomBytes(32).toString('base64url');
}

export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret).digest('hex');
}

/** Digest comparison that does not leak a prefix match through timing. */
function digestsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Constant-time comparison of a presented secret against an expected one.
 *
 * Both sides are hashed first, so the comparison is over two fixed-length
 * digests: `timingSafeEqual` throws on a length mismatch, which would
 * otherwise turn "wrong length" into a distinguishable error and leak the
 * secret's size. This is what a service holding ONE static shared secret
 * needs — a key store is the {@link ApiKeyAuth} path above. It lives here so
 * the signer's admin token and the engine's keys agree on what a constant-time
 * secret check is; the signer had its own copy until S52.
 */
export function secretsEqual(presented: string, expected: string): boolean {
  return digestsEqual(hashSecret(presented), hashSecret(expected));
}

/**
 * Persistence seam for keys, mirroring the engine's other ports. Auth is
 * authority state, so writes are persist-then-cache: `put` is awaited before a
 * key counts as issued, rotated, or revoked.
 */
export interface ApiKeyStorePort {
  put(record: ApiKeyRecord): MaybePromise<void>;
  get(id: string): ApiKeyRecord | undefined;
  /** Lookup by sha256 of a presented secret (current OR in-grace previous). */
  byHash(hash: string): ApiKeyRecord | undefined;
  list(): ApiKeyRecord[];
  /** Drop a key outright. Only ever an EXPIRED one -- see `ApiKeyAuth.remove`. */
  delete(id: string): MaybePromise<void>;
}

export class InMemoryApiKeyStore implements ApiKeyStorePort {
  private readonly byId = new Map<string, ApiKeyRecord>();
  private readonly hashes = new Map<string, string>(); // secretHash -> keyId

  put(record: ApiKeyRecord): void {
    const existing = this.byId.get(record.id);
    if (existing) {
      this.hashes.delete(existing.secretHash);
      if (existing.previousSecretHash) this.hashes.delete(existing.previousSecretHash);
    }
    this.byId.set(record.id, record);
    this.hashes.set(record.secretHash, record.id);
    if (record.previousSecretHash) this.hashes.set(record.previousSecretHash, record.id);
  }

  get(id: string): ApiKeyRecord | undefined {
    return this.byId.get(id);
  }

  byHash(hash: string): ApiKeyRecord | undefined {
    const id = this.hashes.get(hash);
    return id === undefined ? undefined : this.byId.get(id);
  }

  list(): ApiKeyRecord[] {
    return [...this.byId.values()];
  }

  delete(id: string): void {
    const existing = this.byId.get(id);
    if (!existing) return;
    this.hashes.delete(existing.secretHash);
    if (existing.previousSecretHash) this.hashes.delete(existing.previousSecretHash);
    this.byId.delete(id);
  }
}

export type AuthFailureCode =
  | 'missing_credentials'
  | 'invalid_key'
  | 'key_revoked'
  /** Past the key's `expiresAt` (a sandbox key nobody claimed). */
  | 'key_expired'
  | 'secret_expired'
  | 'insufficient_scope'
  | 'unknown_key_id'
  /** The key is confined to an org, and the named agent is not in it. */
  | 'agent_not_in_scope'
  /**
   * The key is confined to an org and the route has no tenant rule, so there
   * is no way to confine the call. Fail closed: an unclassified route is
   * reachable only by an unscoped operator key, exactly as an unclassified
   * route already demands `admin`.
   */
  | 'route_not_scopable';

/**
 * Every rejected request throws one of these. It carries the HTTP status so a
 * route never has to guess: 401 means "we do not know who you are", 403 means
 * "we know, and this key may not do that". Nothing fails open, nothing fails
 * silently.
 */
export class AuthError extends Error {
  /**
   * A brand, because `instanceof` is not enough here. Every service bundles
   * `@reinconsole/core` into its own output (`noExternal`, for self-contained
   * deploys), so an `ApiKeyAuth` built from one package and handed to a server
   * in another throws an AuthError from a DIFFERENT copy of this class. An
   * `instanceof` check in the catching service then misses it and a 401 turns
   * into a 500 — which is what happened the first time the graph was handed
   * the engine's auth object.
   */
  readonly reinAuthError = true;

  constructor(
    readonly status: 401 | 403 | 404,
    readonly code: AuthFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
  }

  /** Use this, never a bare `instanceof`, when catching across packages. */
  static is(err: unknown): err is AuthError {
    return (
      err instanceof AuthError ||
      (typeof err === 'object' &&
        err !== null &&
        (err as { reinAuthError?: unknown }).reinAuthError === true)
    );
  }
}

export interface IssuedApiKey {
  key: ApiKey;
  /** The plaintext secret. Shown once, at issuance; never recoverable after. */
  secret: string;
}

export interface ApiKeyAuthOptions {
  store?: ApiKeyStorePort;
  /** Injected clock, so grace-window behaviour is testable without waiting. */
  now?: () => number;
}

export class ApiKeyAuth {
  private readonly store: ApiKeyStorePort;
  private readonly now: () => number;
  /**
   * Keys with an authority write (rotate, revoke, lift) in flight. A usage
   * touch writes back a WHOLE record snapshot, so one taken while such a write
   * is on its way to disk would land after it and undo it -- re-open a revoked
   * key, or give a claimed sandbox its expiry back. Touches skip these keys.
   */
  private readonly mutating = new Set<string>();

  constructor(options: ApiKeyAuthOptions = {}) {
    this.store = options.store ?? new InMemoryApiKeyStore();
    this.now = options.now ?? Date.now;
  }

  /**
   * Mint a key. The secret in the result is the only copy that will exist.
   *
   * `orgId` confines the key to one tenant; omitting it mints the unscoped
   * operator key that every deployment had before tenancy. `agentIds` narrows
   * an org-scoped key to named agents and is refused without an org, because a
   * scope with no org cannot say which policies or approvers the key may
   * reach — and a half-defined scope is the kind that fails open.
   */
  async issue(input: {
    name: string;
    scopes: ApiKeyScope[];
    /** Confine the key to one org. Omit for an unscoped operator key. */
    orgId?: string;
    /** Narrow an org-scoped key to named agents (max 64). */
    agentIds?: string[];
    /** Adopt a caller-supplied secret (env-seeded boot keys). */
    secret?: string;
    /** Stop authenticating at this instant (sandbox keys). Omit for never. */
    expiresAt?: Date;
  }): Promise<IssuedApiKey> {
    if (input.scopes.length === 0) throw new TypeError('an API key needs at least one scope');
    if (input.agentIds?.length && input.orgId === undefined) {
      throw new TypeError('agentIds narrows an org-scoped key; pass orgId as well');
    }
    const secret = input.secret ?? mintSecret();
    const record = ApiKeyRecord.parse({
      id: newId('key'),
      name: input.name,
      scopes: input.scopes,
      ...(input.orgId !== undefined ? { orgId: input.orgId } : {}),
      ...(input.agentIds?.length ? { agentIds: input.agentIds } : {}),
      createdAt: new Date(this.now()),
      ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
      secretHash: hashSecret(secret),
    });
    await this.store.put(record);
    return { key: toPublicApiKey(record), secret };
  }

  /**
   * Mint a replacement secret for an existing key. The outgoing secret keeps
   * working for `graceMs` so callers can be redeployed one at a time; pass 0
   * to cut it off immediately (what a compromised secret needs).
   */
  async rotate(keyId: string, options: { graceMs?: number } = {}): Promise<IssuedApiKey> {
    const record = this.store.get(keyId);
    if (!record) throw new AuthError(404, 'unknown_key_id', `no such key: ${keyId}`);
    const graceMs = options.graceMs ?? DEFAULT_ROTATION_GRACE_MS;
    const secret = mintSecret();
    const rotated: ApiKeyRecord = {
      ...record,
      secretHash: hashSecret(secret),
      rotatedAt: new Date(this.now()),
    };
    delete rotated.previousSecretHash;
    delete rotated.previousSecretExpiresAt;
    if (graceMs > 0) {
      rotated.previousSecretHash = record.secretHash;
      rotated.previousSecretExpiresAt = new Date(this.now() + graceMs);
    }
    await this.write(rotated);
    return { key: toPublicApiKey(rotated), secret };
  }

  async revoke(keyId: string): Promise<ApiKey | undefined> {
    const record = this.store.get(keyId);
    if (!record) return undefined;
    const revoked: ApiKeyRecord = { ...record, revokedAt: new Date(this.now()) };
    await this.write(revoked);
    return toPublicApiKey(revoked);
  }

  /**
   * Make an expiring key permanent -- what claiming a sandbox is (Sprint 13).
   * Revoked keys stay revoked: lifting an expiry never resurrects anything.
   * Answers undefined for an unknown key, the record unchanged when there was
   * no expiry to lift.
   */
  async clearExpiry(keyId: string): Promise<ApiKey | undefined> {
    const record = this.store.get(keyId);
    if (!record) return undefined;
    if (record.expiresAt === undefined) return toPublicApiKey(record);
    const lifted: ApiKeyRecord = { ...record };
    delete lifted.expiresAt;
    await this.write(lifted);
    return toPublicApiKey(lifted);
  }

  /**
   * Delete an EXPIRED key's row. Refused for anything else, because a deleted
   * row forgets more than a key: an env-seeded secret would be re-issued at
   * the next boot, resurrecting a revocation. Expiring keys are never
   * env-seeded (sandbox and owner-session keys only), and an expired secret
   * already authenticates nothing, so dropping one changes no answer but the
   * error code -- `invalid_key` instead of `key_expired`.
   *
   * No `touch` can overtake this: `authenticate` throws on an expired key
   * before it touches, so nothing writes the snapshot back afterwards.
   */
  async remove(keyId: string): Promise<boolean> {
    const record = this.store.get(keyId);
    if (!record) return false;
    if (record.expiresAt === undefined || this.now() < record.expiresAt.getTime()) {
      throw new TypeError(`refusing to delete key ${keyId}: only an expired key may be deleted`);
    }
    this.mutating.add(keyId);
    try {
      await this.store.delete(keyId);
    } finally {
      this.mutating.delete(keyId);
    }
    return true;
  }

  list(): ApiKey[] {
    return this.store.list().map(toPublicApiKey);
  }

  /** One key's public record, for an ownership check before rotate/revoke. */
  get(keyId: string): ApiKey | undefined {
    const record = this.store.get(keyId);
    return record === undefined ? undefined : toPublicApiKey(record);
  }

  /** True once at least one key exists — what "auth is configured" means. */
  hasKeys(): boolean {
    return this.store.list().length > 0;
  }

  /**
   * Resolve a request's credentials, or throw. `scope` is what the route
   * needs; an `admin` key satisfies every scope, any other key must hold the
   * exact one.
   */
  authenticate(headers: IncomingHeaders, scope: ApiKeyScope): ApiKey {
    const presented = readCredential(headers);
    if (presented === undefined) {
      throw new AuthError(401, 'missing_credentials', 'missing API key (Authorization: Bearer ...)');
    }

    const hash = hashSecret(presented);
    const record = this.store.byHash(hash);
    if (!record) throw new AuthError(401, 'invalid_key', 'unknown API key');

    if (!digestsEqual(record.secretHash, hash)) {
      // Only the in-grace previous secret can reach here.
      const expiry = record.previousSecretExpiresAt;
      if (
        record.previousSecretHash === undefined ||
        !digestsEqual(record.previousSecretHash, hash) ||
        expiry === undefined ||
        this.now() >= expiry.getTime()
      ) {
        throw new AuthError(401, 'secret_expired', 'rotated API key secret is no longer accepted');
      }
    }

    if (record.revokedAt) throw new AuthError(401, 'key_revoked', 'API key has been revoked');
    if (record.expiresAt && this.now() >= record.expiresAt.getTime()) {
      throw new AuthError(401, 'key_expired', 'API key has expired');
    }

    if (!record.scopes.includes('admin') && !record.scopes.includes(scope)) {
      throw new AuthError(403, 'insufficient_scope', `API key lacks the "${scope}" scope`);
    }

    void this.touch(record);
    return toPublicApiKey(record);
  }

  /** An authority write that usage touches must not overtake (see `mutating`). */
  private async write(record: ApiKeyRecord): Promise<void> {
    this.mutating.add(record.id);
    try {
      await this.store.put(record);
    } finally {
      this.mutating.delete(record.id);
    }
  }

  /** Throttled write-through of `lastUsedAt` — never on the critical path. */
  private async touch(record: ApiKeyRecord): Promise<void> {
    const at = this.now();
    if (this.mutating.has(record.id)) return;
    if (record.lastUsedAt && at - record.lastUsedAt.getTime() < TOUCH_INTERVAL_MS) return;
    try {
      await this.store.put({ ...record, lastUsedAt: new Date(at) });
    } catch {
      // Usage telemetry must never turn a valid request into a failed one.
    }
  }
}

/** Just enough of a request's headers to read a credential from. */
export interface IncomingHeaders {
  authorization?: string | string[] | undefined;
  'x-api-key'?: string | string[] | undefined;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * `Authorization: Bearer <secret>` is the primary form; `X-Api-Key: <secret>`
 * is accepted too, because a fair share of agent runtimes only send that.
 */
export function readCredential(headers: IncomingHeaders): string | undefined {
  const auth = first(headers.authorization)?.trim();
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match?.[1]) return match[1].trim();
  }
  const apiKey = first(headers['x-api-key'])?.trim();
  return apiKey === undefined || apiKey === '' ? undefined : apiKey;
}
