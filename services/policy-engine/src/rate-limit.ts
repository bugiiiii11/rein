/**
 * Token-bucket rate limiting for the engine's HTTP surface.
 *
 * In-house and dependency-free on purpose: the engine is the component whose
 * dependency list has to stay auditable, and a limiter is eighty lines. It is
 * a bucket per key, refilled lazily — no timers, no sweep interval, nothing
 * that keeps a process alive or fires while the engine is idle. A bucket is
 * touched only by a request that names it.
 *
 * Two limiters run in front of every request, and they are NOT the same
 * defence (see `buildServer`):
 *
 * - per IP, BEFORE authentication, so a caller with no key at all cannot
 *   hammer the credential check. This one bounds work the engine does on
 *   behalf of someone who has proved nothing, `/health` included.
 * - per API KEY, AFTER authentication, so one tenant's runaway agent cannot
 *   spend the engine's capacity on everyone else's behalf. It has to run after
 *   auth because the key id only exists once auth resolved it, and keying on
 *   the presented secret instead would let a single caller mint unlimited
 *   buckets by varying a header.
 *
 * Neither is a security boundary on its own: an attacker with many source
 * addresses defeats the first, and a legitimate key defeats the second by
 * asking for a bigger one. They exist so that a single misbehaving client
 * degrades itself rather than the deployment.
 */

/** How many buckets a limiter holds before it sweeps the idle ones. */
const DEFAULT_MAX_KEYS = 10_000;

export interface TokenBucketOptions {
  /**
   * Burst: the most requests one key may make back to back, and the bucket's
   * ceiling. A key that has been quiet is allowed exactly this many at once.
   */
  capacity: number;
  /** Sustained rate, in requests per second, at which a bucket refills. */
  refillPerSec: number;
  /**
   * Bucket ceiling before idle buckets are swept. Only FULL buckets are
   * dropped: a full bucket is indistinguishable from one that never existed,
   * so forgetting it costs nothing, while dropping a drained one would hand
   * its owner a fresh burst simply by growing the map past its ceiling.
   */
  maxKeys?: number;
}

/** What a limiter says about one request. */
export interface RateLimitVerdict {
  allowed: boolean;
  /**
   * Seconds until the bucket has a token again, for the `Retry-After` header.
   * At least 1 — `Retry-After: 0` reads as "retry immediately", which is the
   * opposite of what a 429 means. Zero only when `allowed`.
   */
  retryAfterSec: number;
}

interface Bucket {
  /** Tokens left at `at`. Fractional: a refill of 0.4 tokens is not nothing. */
  tokens: number;
  /** When `tokens` was last computed. */
  at: number;
}

const ALLOWED: RateLimitVerdict = { allowed: true, retryAfterSec: 0 };

/**
 * A lazily-refilled token bucket per key.
 *
 * Lazy refill is what keeps this free when nothing is happening: a bucket's
 * token count is a function of the time since it was last touched, so it is
 * computed on read rather than advanced by a timer.
 */
export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly capacity: number;
  private readonly refillPerSec: number;
  private readonly maxKeys: number;

  constructor(options: TokenBucketOptions) {
    if (!Number.isFinite(options.capacity) || options.capacity <= 0) {
      throw new TypeError(`rate limit capacity must be a positive number, got ${options.capacity}`);
    }
    if (!Number.isFinite(options.refillPerSec) || options.refillPerSec <= 0) {
      throw new TypeError(
        `rate limit refillPerSec must be a positive number, got ${options.refillPerSec}`,
      );
    }
    this.capacity = options.capacity;
    this.refillPerSec = options.refillPerSec;
    this.maxKeys = options.maxKeys ?? DEFAULT_MAX_KEYS;
  }

  /** Spend one token for `key`, or refuse and say how long to wait. */
  take(key: string, nowMs: number = Date.now()): RateLimitVerdict {
    const bucket = this.buckets.get(key);
    if (bucket === undefined) {
      // Only sweep when a NEW key would grow the map past the ceiling: a
      // steady-state deployment with fewer keys than that never sweeps at all.
      if (this.buckets.size >= this.maxKeys) this.sweep(nowMs);
      this.buckets.set(key, { tokens: this.capacity - 1, at: nowMs });
      return ALLOWED;
    }
    // A clock that went backwards (an NTP step, a test's fake timer) must not
    // credit tokens, hence the max(0, ...).
    const elapsedSec = Math.max(0, nowMs - bucket.at) / 1000;
    const tokens = Math.min(this.capacity, bucket.tokens + elapsedSec * this.refillPerSec);
    if (tokens < 1) {
      // A REFUSED request leaves the bucket completely untouched, which is two
      // properties in one line. The obvious one: a client hammering its own
      // 429 cannot reset the countdown it is waiting on. The subtle one: the
      // token count stays a SINGLE multiplication from the last successful
      // take rather than a running sum of small increments, so it carries no
      // floating-point drift — and drift here is not cosmetic, since a
      // hundred retries that each accrue 0.01 of a token can leave the bucket
      // fractionally short of 1 forever and lock a well-behaved client out.
      return {
        allowed: false,
        retryAfterSec: Math.max(1, Math.ceil((1 - tokens) / this.refillPerSec)),
      };
    }
    bucket.tokens = tokens - 1;
    bucket.at = nowMs;
    return ALLOWED;
  }

  /** Buckets currently held (tests, and the unbounded-key guard above). */
  get size(): number {
    return this.buckets.size;
  }

  /** Drop buckets that have refilled completely — they carry no state. */
  private sweep(nowMs: number): void {
    for (const [key, bucket] of this.buckets) {
      const elapsedSec = Math.max(0, nowMs - bucket.at) / 1000;
      if (bucket.tokens + elapsedSec * this.refillPerSec >= this.capacity) {
        this.buckets.delete(key);
      }
    }
  }
}

/** The engine's two limiters, as `buildServer` takes them. */
export interface RateLimitOptions {
  /** Per authenticated API key. Default 120 burst, 10 rps. */
  perKey?: TokenBucketOptions;
  /** Per client IP, applied before auth. Default 30 burst, 1 rps. */
  perIp?: TokenBucketOptions;
}

export const DEFAULT_PER_KEY: TokenBucketOptions = { capacity: 120, refillPerSec: 10 };
export const DEFAULT_PER_IP: TokenBucketOptions = { capacity: 30, refillPerSec: 1 };

/** Both limiters, built once per server. */
export interface RateLimiters {
  perKey: TokenBucketLimiter;
  perIp: TokenBucketLimiter;
}

export function buildRateLimiters(options: RateLimitOptions = {}): RateLimiters {
  return {
    perKey: new TokenBucketLimiter(options.perKey ?? DEFAULT_PER_KEY),
    perIp: new TokenBucketLimiter(options.perIp ?? DEFAULT_PER_IP),
  };
}

/**
 * Rate-limit configuration from the environment, or `undefined` for none.
 *
 * Off by default, on for the deployed bins: an embedded engine (the console
 * world, the demos, every in-process test) shares a process with its only
 * caller, so a limiter there could only ever refuse the application itself.
 *
 * - `REIN_ENGINE_RATE_LIMIT=off` disables it outright on a bin that would
 *   otherwise have it — the deliberate opt-out, mirroring REIN_ENGINE_AUTH=off.
 * - `REIN_ENGINE_RATE_LIMIT_PER_KEY` / `_PER_KEY_BURST` and
 *   `REIN_ENGINE_RATE_LIMIT_PER_IP` / `_PER_IP_BURST` override rate and burst.
 *
 * A non-numeric or non-positive override is a startup ERROR rather than a
 * silent fallback: `PER_KEY=0` most likely means "no limit" to whoever typed
 * it, and quietly reading it as the default would leave an operator believing
 * they had turned something off when they had in fact turned it on.
 */
export function rateLimitFromEnv(env: NodeJS.ProcessEnv): RateLimitOptions | undefined {
  if (env['REIN_ENGINE_RATE_LIMIT']?.trim().toLowerCase() === 'off') return undefined;
  return {
    perKey: {
      capacity: positive(env, 'REIN_ENGINE_RATE_LIMIT_PER_KEY_BURST', DEFAULT_PER_KEY.capacity),
      refillPerSec: positive(env, 'REIN_ENGINE_RATE_LIMIT_PER_KEY', DEFAULT_PER_KEY.refillPerSec),
    },
    perIp: {
      capacity: positive(env, 'REIN_ENGINE_RATE_LIMIT_PER_IP_BURST', DEFAULT_PER_IP.capacity),
      refillPerSec: positive(env, 'REIN_ENGINE_RATE_LIMIT_PER_IP', DEFAULT_PER_IP.refillPerSec),
    },
  };
}

function positive(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(
      `${name} must be a positive number, got ${JSON.stringify(raw)}. ` +
        'Set REIN_ENGINE_RATE_LIMIT=off to disable rate limiting deliberately.',
    );
  }
  return value;
}
