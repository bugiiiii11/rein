import { describe, it, expect } from 'vitest';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { buildServer } from './server.js';
import { PolicyEngine } from './engine.js';
import {
  DEFAULT_PER_IP,
  DEFAULT_PER_KEY,
  TokenBucketLimiter,
  rateLimitFromEnv,
} from './rate-limit.js';

/** A2's capacity half: what one client can make the engine do. */

describe('TokenBucketLimiter', () => {
  it('admits a full burst and refuses the next one', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSec: 1 });
    const now = 1_000_000;
    expect(limiter.take('k', now).allowed).toBe(true);
    expect(limiter.take('k', now).allowed).toBe(true);
    expect(limiter.take('k', now).allowed).toBe(true);
    expect(limiter.take('k', now).allowed).toBe(false);
  });

  it('refills lazily, at the configured rate and no faster', () => {
    const limiter = new TokenBucketLimiter({ capacity: 2, refillPerSec: 2 });
    const t0 = 5_000_000;
    limiter.take('k', t0);
    limiter.take('k', t0);
    expect(limiter.take('k', t0).allowed).toBe(false);
    // 2 rps means one token every 500ms. At 400ms there is still not one.
    expect(limiter.take('k', t0 + 400).allowed).toBe(false);
    expect(limiter.take('k', t0 + 500).allowed).toBe(true);
  });

  it('never refills past the burst ceiling, however long the key was idle', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSec: 10 });
    const t0 = 2_000_000;
    limiter.take('k', t0);
    // An hour of idling is worth 36,000 tokens and still buys exactly 3.
    const later = t0 + 3_600_000;
    expect(limiter.take('k', later).allowed).toBe(true);
    expect(limiter.take('k', later).allowed).toBe(true);
    expect(limiter.take('k', later).allowed).toBe(true);
    expect(limiter.take('k', later).allowed).toBe(false);
  });

  it('keys are independent — one client cannot spend another one`s allowance', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1 });
    const now = 7_000_000;
    expect(limiter.take('a', now).allowed).toBe(true);
    expect(limiter.take('a', now).allowed).toBe(false);
    expect(limiter.take('b', now).allowed).toBe(true);
  });

  it('says how long to wait, and never says zero', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSec: 0.25 });
    const t0 = 9_000_000;
    limiter.take('k', t0);
    // A quarter token per second: a full token is 4s away.
    expect(limiter.take('k', t0).retryAfterSec).toBe(4);
    expect(limiter.take('k', t0 + 3_000).retryAfterSec).toBe(1);
  });

  it('a client hammering the refusal does not reset its own recovery', () => {
    // The failure this pins: if a refused request moved the bucket's clock
    // without crediting the elapsed refill, a tight retry loop would keep
    // resetting the countdown and never be let back in.
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1 });
    const t0 = 11_000_000;
    limiter.take('k', t0);
    for (let ms = 100; ms < 1000; ms += 100) {
      expect(limiter.take('k', t0 + ms).allowed).toBe(false);
    }
    expect(limiter.take('k', t0 + 1000).allowed).toBe(true);
  });

  it('a clock that runs backwards credits nothing', () => {
    const limiter = new TokenBucketLimiter({ capacity: 1, refillPerSec: 1 });
    const t0 = 13_000_000;
    limiter.take('k', t0);
    expect(limiter.take('k', t0 - 60_000).allowed).toBe(false);
  });

  it('sweeps only the buckets that have refilled, so a drained one keeps its state', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSec: 1, maxKeys: 3 });
    const t0 = 17_000_000;
    // `drained` spends its whole burst; the other two spend one each.
    limiter.take('drained', t0);
    limiter.take('drained', t0);
    limiter.take('drained', t0);
    limiter.take('idle', t0);
    limiter.take('third', t0);
    expect(limiter.size).toBe(3);

    // A new key at maxKeys triggers the sweep. One second later `idle` and
    // `third` are back at the ceiling and are forgotten (a full bucket is
    // indistinguishable from one that never existed); `drained` is not.
    const later = t0 + 1_000;
    limiter.take('fresh', later);
    expect(limiter.size).toBe(2);

    // And it kept its state rather than being handed a fresh burst: one
    // second bought it exactly one token, not the three a new key gets.
    expect(limiter.take('drained', later).allowed).toBe(true);
    expect(limiter.take('drained', later).allowed).toBe(false);
  });

  it('refuses a nonsense configuration instead of limiting nobody', () => {
    expect(() => new TokenBucketLimiter({ capacity: 0, refillPerSec: 1 })).toThrow(/capacity/);
    expect(() => new TokenBucketLimiter({ capacity: 1, refillPerSec: 0 })).toThrow(/refillPerSec/);
  });
});

describe('rateLimitFromEnv', () => {
  it('defaults to 120/10 per key and 30/1 per IP', () => {
    const options = rateLimitFromEnv({});
    expect(options?.perKey).toEqual(DEFAULT_PER_KEY);
    expect(options?.perIp).toEqual(DEFAULT_PER_IP);
  });

  it('REIN_ENGINE_RATE_LIMIT=off is the deliberate opt-out', () => {
    expect(rateLimitFromEnv({ REIN_ENGINE_RATE_LIMIT: 'off' })).toBeUndefined();
    expect(rateLimitFromEnv({ REIN_ENGINE_RATE_LIMIT: 'OFF' })).toBeUndefined();
  });

  it('takes rate and burst overrides separately', () => {
    const options = rateLimitFromEnv({
      REIN_ENGINE_RATE_LIMIT_PER_KEY: '40',
      REIN_ENGINE_RATE_LIMIT_PER_KEY_BURST: '400',
      REIN_ENGINE_RATE_LIMIT_PER_IP: '5',
    });
    expect(options?.perKey).toEqual({ capacity: 400, refillPerSec: 40 });
    expect(options?.perIp).toEqual({ capacity: 30, refillPerSec: 5 });
  });

  it('a zero or garbage override is a startup error, not a silent default', () => {
    // Somebody typing PER_KEY=0 means "no limit". Reading it as 10 rps would
    // leave them believing a limiter is off while it is fully on.
    expect(() => rateLimitFromEnv({ REIN_ENGINE_RATE_LIMIT_PER_KEY: '0' })).toThrow(/positive/);
    expect(() => rateLimitFromEnv({ REIN_ENGINE_RATE_LIMIT_PER_IP: 'lots' })).toThrow(/positive/);
  });
});

describe('the engine under a rate limit', () => {
  /** One token per bucket, refilling slowly enough that the test never waits. */
  const tight = { perKey: { capacity: 1, refillPerSec: 0.01 }, perIp: { capacity: 4, refillPerSec: 0.01 } };

  async function limitedServer(rateLimit = tight) {
    const auth = new ApiKeyAuth();
    const admin = await auth.issue({ name: 'ops', scopes: ['admin'] });
    const other = await auth.issue({ name: 'ops-2', scopes: ['admin'] });
    return { app: buildServer(new PolicyEngine(), { auth, rateLimit }), admin, other };
  }

  it('answers 429 with a Retry-After a client can act on', async () => {
    const { app, admin } = await limitedServer();
    const headers = { authorization: `Bearer ${admin.secret}` };
    expect((await app.inject({ method: 'GET', url: '/v1/agents', headers })).statusCode).toBe(200);

    const res = await app.inject({ method: 'GET', url: '/v1/agents', headers });
    expect(res.statusCode).toBe(429);
    expect(res.json().error).toBe('rate_limited');
    expect(Number(res.headers['retry-after'])).toBeGreaterThan(0);
    await app.close();
  });

  it('throttles per KEY, so one tenant`s runaway agent is not everyone`s outage', async () => {
    const { app, admin, other } = await limitedServer();
    await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${admin.secret}` },
    });
    const drained = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${admin.secret}` },
    });
    expect(drained.statusCode).toBe(429);

    // Same IP, different key: unaffected.
    const neighbour = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${other.secret}` },
    });
    expect(neighbour.statusCode).toBe(200);
    await app.close();
  });

  it('throttles per IP BEFORE auth, so an unauthenticated caller cannot hammer the key check', async () => {
    const { app } = await limitedServer({
      perKey: { capacity: 100, refillPerSec: 100 },
      perIp: { capacity: 2, refillPerSec: 0.01 },
    });
    const bad = { authorization: 'Bearer nonsense' };
    expect((await app.inject({ method: 'GET', url: '/v1/agents', headers: bad })).statusCode).toBe(
      401,
    );
    expect((await app.inject({ method: 'GET', url: '/v1/agents', headers: bad })).statusCode).toBe(
      401,
    );
    const third = await app.inject({ method: 'GET', url: '/v1/agents', headers: bad });
    // 429, not 401: the credential was never looked at.
    expect(third.statusCode).toBe(429);
    await app.close();
  });

  it('covers /health too — it is the cheapest thing on the surface to hammer', async () => {
    const { app } = await limitedServer({
      perKey: { capacity: 100, refillPerSec: 100 },
      perIp: { capacity: 1, refillPerSec: 0.01 },
    });
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(429);
    await app.close();
  });

  it('an embedded engine has no limiter at all', async () => {
    // The console world and the demos build one of these. A limiter there
    // could only ever refuse the application that owns the engine.
    const app = buildServer(new PolicyEngine());
    for (let i = 0; i < 50; i += 1) {
      expect((await app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    }
    await app.close();
  });

  it('caps the request body, so an unauthenticated caller cannot make it buffer', async () => {
    const { app, admin } = await limitedServer({
      perKey: { capacity: 100, refillPerSec: 100 },
      perIp: { capacity: 100, refillPerSec: 100 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${admin.secret}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ policyId: 'pol_x', note: 'x'.repeat(70_000) }),
    });
    expect(res.statusCode).toBe(413);
    await app.close();
  });
});
