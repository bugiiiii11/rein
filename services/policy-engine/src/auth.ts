import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ApiKeyRecord, newId, toPublicApiKey, type ApiKey, type ApiKeyScope } from '@reinconsole/core';
import type { MaybePromise } from './stores.js';

/**
 * API-key authentication for the engine's HTTP surface.
 *
 * Secrets are never stored: the engine keeps sha256 digests, so a leaked
 * database yields nothing that authenticates. A secret is returned exactly
 * once, at issuance. Rotation mints a new secret while keeping the outgoing
 * digest valid for a grace window, so a fleet rolls over without a flag-day
 * restart.
 */

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
}

export type AuthFailureCode =
  | 'missing_credentials'
  | 'invalid_key'
  | 'key_revoked'
  | 'secret_expired'
  | 'insufficient_scope'
  | 'unknown_key_id';

/**
 * Every rejected request throws one of these. It carries the HTTP status so a
 * route never has to guess: 401 means "we do not know who you are", 403 means
 * "we know, and this key may not do that". Nothing fails open, nothing fails
 * silently.
 */
export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403 | 404,
    readonly code: AuthFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'AuthError';
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

  constructor(options: ApiKeyAuthOptions = {}) {
    this.store = options.store ?? new InMemoryApiKeyStore();
    this.now = options.now ?? Date.now;
  }

  /** Mint a key. The secret in the result is the only copy that will exist. */
  async issue(input: {
    name: string;
    scopes: ApiKeyScope[];
    /** Adopt a caller-supplied secret (env-seeded boot keys). */
    secret?: string;
  }): Promise<IssuedApiKey> {
    if (input.scopes.length === 0) throw new TypeError('an API key needs at least one scope');
    const secret = input.secret ?? mintSecret();
    const record = ApiKeyRecord.parse({
      id: newId('key'),
      name: input.name,
      scopes: input.scopes,
      createdAt: new Date(this.now()),
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
    await this.store.put(rotated);
    return { key: toPublicApiKey(rotated), secret };
  }

  async revoke(keyId: string): Promise<ApiKey | undefined> {
    const record = this.store.get(keyId);
    if (!record) return undefined;
    const revoked: ApiKeyRecord = { ...record, revokedAt: new Date(this.now()) };
    await this.store.put(revoked);
    return toPublicApiKey(revoked);
  }

  list(): ApiKey[] {
    return this.store.list().map(toPublicApiKey);
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

    if (!record.scopes.includes('admin') && !record.scopes.includes(scope)) {
      throw new AuthError(403, 'insufficient_scope', `API key lacks the "${scope}" scope`);
    }

    void this.touch(record);
    return toPublicApiKey(record);
  }

  /** Throttled write-through of `lastUsedAt` — never on the critical path. */
  private async touch(record: ApiKeyRecord): Promise<void> {
    const at = this.now();
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
