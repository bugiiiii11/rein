import { describe, it, expect } from 'vitest';
import { ApiKeyAuth, AuthError, hashSecret, mintSecret, readCredential } from './auth.js';

function bearer(secret: string) {
  return { authorization: `Bearer ${secret}` };
}

describe('ApiKeyAuth', () => {
  it('issues a key whose secret is returned once and never stored', async () => {
    const auth = new ApiKeyAuth();
    const { key, secret } = await auth.issue({ name: 'agent fleet', scopes: ['evaluate'] });

    expect(key.id).toMatch(/^key_/);
    expect(secret.startsWith('rk_')).toBe(true);
    // The public record carries no digest, let alone the secret itself.
    expect(JSON.stringify(key)).not.toContain(secret);
    expect(JSON.stringify(auth.list())).not.toContain('secretHash');
  });

  it('accepts the secret it issued and rejects everything else', async () => {
    const auth = new ApiKeyAuth();
    const { key, secret } = await auth.issue({ name: 'fleet', scopes: ['evaluate'] });

    expect(auth.authenticate(bearer(secret), 'evaluate').id).toBe(key.id);
    expect(() => auth.authenticate(bearer(mintSecret()), 'evaluate')).toThrow(AuthError);
    expect(() => auth.authenticate({}, 'evaluate')).toThrow(/missing API key/);
  });

  it('reads the credential from either header, Bearer case-insensitively', () => {
    expect(readCredential({ authorization: 'Bearer rk_abc' })).toBe('rk_abc');
    expect(readCredential({ authorization: 'bearer rk_abc' })).toBe('rk_abc');
    expect(readCredential({ 'x-api-key': 'rk_abc' })).toBe('rk_abc');
    expect(readCredential({ authorization: 'Basic zzz' })).toBeUndefined();
    expect(readCredential({})).toBeUndefined();
  });

  it('separates 401 (who are you) from 403 (not allowed)', async () => {
    const auth = new ApiKeyAuth();
    const { secret } = await auth.issue({ name: 'reader', scopes: ['read'] });

    let unknown: AuthError | undefined;
    try {
      auth.authenticate(bearer('rk_nope'), 'read');
    } catch (err) {
      unknown = err as AuthError;
    }
    expect(unknown?.status).toBe(401);
    expect(unknown?.code).toBe('invalid_key');

    let scoped: AuthError | undefined;
    try {
      auth.authenticate(bearer(secret), 'admin');
    } catch (err) {
      scoped = err as AuthError;
    }
    expect(scoped?.status).toBe(403);
    expect(scoped?.code).toBe('insufficient_scope');
  });

  it('lets an admin key satisfy every scope', async () => {
    const auth = new ApiKeyAuth();
    const { secret } = await auth.issue({ name: 'ops', scopes: ['admin'] });
    for (const scope of ['read', 'evaluate', 'approve', 'admin'] as const) {
      expect(auth.authenticate(bearer(secret), scope)).toBeDefined();
    }
  });

  it('keeps the outgoing secret alive through the rotation grace, then drops it', async () => {
    let now = 1_000_000;
    const auth = new ApiKeyAuth({ now: () => now });
    const { key, secret: original } = await auth.issue({ name: 'fleet', scopes: ['evaluate'] });

    const { secret: replacement } = await auth.rotate(key.id, { graceMs: 60_000 });
    expect(replacement).not.toBe(original);

    // Both work during the overlap — that is the whole point of a rotation.
    expect(auth.authenticate(bearer(original), 'evaluate').id).toBe(key.id);
    expect(auth.authenticate(bearer(replacement), 'evaluate').id).toBe(key.id);

    now += 60_001;
    expect(() => auth.authenticate(bearer(original), 'evaluate')).toThrow(/no longer accepted/);
    expect(auth.authenticate(bearer(replacement), 'evaluate').id).toBe(key.id);
  });

  it('kills the old secret immediately when the grace is zero', async () => {
    const auth = new ApiKeyAuth();
    const { key, secret: original } = await auth.issue({ name: 'leaked', scopes: ['evaluate'] });
    const { secret: replacement } = await auth.rotate(key.id, { graceMs: 0 });

    expect(() => auth.authenticate(bearer(original), 'evaluate')).toThrow(AuthError);
    expect(auth.authenticate(bearer(replacement), 'evaluate').id).toBe(key.id);
  });

  it('refuses a revoked key even with the right secret and scope', async () => {
    const auth = new ApiKeyAuth();
    const { key, secret } = await auth.issue({ name: 'retired', scopes: ['admin'] });
    await auth.revoke(key.id);

    let error: AuthError | undefined;
    try {
      auth.authenticate(bearer(secret), 'read');
    } catch (err) {
      error = err as AuthError;
    }
    expect(error?.code).toBe('key_revoked');
    expect(error?.status).toBe(401);
  });

  it('adopts an env-supplied secret so a boot key can be pinned', async () => {
    const auth = new ApiKeyAuth();
    await auth.issue({ name: 'env', scopes: ['admin'], secret: 'rk_from_the_environment' });
    expect(auth.authenticate(bearer('rk_from_the_environment'), 'admin')).toBeDefined();
    expect(auth.hasKeys()).toBe(true);
  });

  it('hashes deterministically and never round-trips', () => {
    const secret = mintSecret();
    expect(hashSecret(secret)).toBe(hashSecret(secret));
    expect(hashSecret(secret)).toHaveLength(64);
    expect(hashSecret(secret)).not.toContain(secret);
  });

  it('rejects a key with no scopes at all', async () => {
    const auth = new ApiKeyAuth();
    await expect(auth.issue({ name: 'useless', scopes: [] })).rejects.toThrow(/at least one scope/);
  });
});

describe('AuthError across package boundaries', () => {
  it('recognises an AuthError thrown by a DIFFERENT bundled copy of itself', () => {
    const auth = new ApiKeyAuth();
    let thrown: unknown;
    try {
      auth.authenticate({}, 'read');
    } catch (err) {
      thrown = err;
    }
    expect(AuthError.is(thrown)).toBe(true);

    // What a second copy looks like from here: every service bundles core into
    // its own output, so an auth object built in one package throws a class
    // the catching package has never seen. `instanceof` misses it and the 401
    // becomes a 500 — the brand is what keeps the status honest.
    const foreign = Object.assign(new Error('unknown API key'), {
      name: 'AuthError',
      status: 401,
      code: 'invalid_key',
      reinAuthError: true,
    });
    expect(foreign instanceof AuthError).toBe(false);
    expect(AuthError.is(foreign)).toBe(true);

    // Not so loose that anything error-shaped passes.
    expect(AuthError.is(new Error('nope'))).toBe(false);
    expect(AuthError.is({ reinAuthError: 'yes' })).toBe(false);
    expect(AuthError.is(undefined)).toBe(false);
  });
});
