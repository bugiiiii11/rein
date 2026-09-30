/**
 * The console's bridge to the engine's claim routes (Sprint 13.2-13.3).
 *
 * The console holds ONE credential for this: an unscoped key with only the
 * `identity` scope (`REIN_CONSOLE_IDENTITY_KEY`). It can redeem a claim code
 * for an identity sign-in has verified, and it can ask for a short-lived read
 * key for the org that identity owns. It cannot read any org by itself -- every
 * dashboard an owner sees is rendered through a key the engine confined to
 * their org, the same tenant filter every other key goes through.
 *
 * Owner worlds are the ordinary `RemoteWorld`, one per claimed org that
 * somebody is looking at, polled like the public one and closed after a spell
 * with nobody watching. The session key is renewed before it lapses without
 * rebuilding the world.
 */
import type { ServerEvent } from './wire';
import type { World } from './world';
import { createRemoteWorld, type RemoteWorld, type RemoteWorldOptions } from './remote-world';

export interface OwnerBridgeOptions {
  engineUrl: string;
  /** Unscoped, `identity` scope only. */
  identityKey: string;
  pollMs?: number;
  /** Close an owner world nobody has touched for this long (default 10 min). */
  idleMs?: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injected for tests. */
  createWorld?: (options: RemoteWorldOptions) => Promise<RemoteWorld>;
}

export interface OwnerView {
  orgId: string;
  world: World;
}

export class EngineRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OwnerBridge {
  redeem(code: string, identity: string): Promise<{ orgId: string; alreadyOwned: boolean }>;
  /** The owner's org and its world, or undefined when this identity owns none. */
  viewFor(identity: string): Promise<OwnerView | undefined>;
  close(): Promise<void>;
}

/** Renew a session key this long before it lapses. */
const RENEW_BEFORE_MS = 60 * 60 * 1000;
/** A signed-in visitor who owns nothing is re-asked at most this often. */
const NOT_OWNER_CACHE_MS = 15_000;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;

interface Entry {
  orgId: string;
  apiKey: string;
  keyExp: number;
  world: RemoteWorld;
  view: World;
  lastUsed: number;
  watchers: number;
}

export function createOwnerBridge(options: OwnerBridgeOptions): OwnerBridge {
  const base = options.engineUrl.replace(/\/+$/, '');
  const doFetch = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const idleMs = options.idleMs ?? DEFAULT_IDLE_MS;
  const build = options.createWorld ?? createRemoteWorld;
  const entries = new Map<string, Entry>();
  const notOwner = new Map<string, number>();
  /** One in-flight build per identity, so a burst of requests makes one world. */
  const building = new Map<string, Promise<OwnerView | undefined>>();

  async function post<T>(path: string, body: object): Promise<T> {
    const res = await doFetch(`${base}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${options.identityKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok) {
      throw new EngineRefusal(
        res.status,
        String(json['error'] ?? 'engine_error'),
        String(json['message'] ?? `engine answered ${res.status}`),
      );
    }
    return json as T;
  }

  async function session(identity: string): Promise<{ orgId: string; apiKey: string; expiresAt: string } | undefined> {
    try {
      return await post('/v1/owners/session', { identity });
    } catch (err) {
      if (err instanceof EngineRefusal && err.code === 'not_an_owner') return undefined;
      throw err;
    }
  }

  /** Count SSE watchers, so an open dashboard is never evicted as idle. */
  function watched(entry: Entry): World {
    const world = entry.world;
    return {
      ...world,
      getState: () => world.getState(),
      subscribe(listener: (ev: ServerEvent) => void) {
        entry.watchers += 1;
        const off = world.subscribe(listener);
        let done = false;
        return () => {
          if (done) return;
          done = true;
          entry.watchers -= 1;
          entry.lastUsed = now();
          off();
        };
      },
    };
  }

  async function open(identity: string): Promise<OwnerView | undefined> {
    const s = await session(identity);
    if (!s) {
      notOwner.set(identity, now());
      return undefined;
    }
    const entry = { orgId: s.orgId, apiKey: s.apiKey, keyExp: Date.parse(s.expiresAt), lastUsed: now(), watchers: 0 } as Entry;
    entry.world = await build({
      engineUrl: base,
      // Read at every request, so a renewed key takes effect without a rebuild.
      apiKey: () => entry.apiKey,
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
      ...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
    });
    entry.view = watched(entry);
    entries.set(identity, entry);
    return { orgId: entry.orgId, world: entry.view };
  }

  async function renew(identity: string, entry: Entry): Promise<OwnerView | undefined> {
    const s = await session(identity);
    if (!s || s.orgId !== entry.orgId) {
      // Released (the owner key was revoked) or re-bound: this world is no
      // longer theirs to see.
      entries.delete(identity);
      await entry.world.close();
      return s ? open(identity) : undefined;
    }
    entry.apiKey = s.apiKey;
    entry.keyExp = Date.parse(s.expiresAt);
    return { orgId: entry.orgId, world: entry.view };
  }

  const sweeper = setInterval(() => {
    const t = now();
    for (const [identity, entry] of entries) {
      if (entry.watchers === 0 && t - entry.lastUsed >= idleMs) {
        entries.delete(identity);
        void entry.world.close();
      }
    }
    for (const [identity, at] of notOwner) if (t - at >= NOT_OWNER_CACHE_MS) notOwner.delete(identity);
  }, 60_000);
  sweeper.unref?.();

  return {
    async redeem(code, identity) {
      const out = await post<{ orgId: string; alreadyOwned: boolean }>('/v1/claims/redeem', { code, identity });
      notOwner.delete(identity);
      return { orgId: out.orgId, alreadyOwned: out.alreadyOwned };
    },

    viewFor(identity) {
      const t = now();
      const entry = entries.get(identity);
      if (entry) {
        entry.lastUsed = t;
        if (entry.keyExp - t > RENEW_BEFORE_MS) return Promise.resolve({ orgId: entry.orgId, world: entry.view });
      } else {
        const miss = notOwner.get(identity);
        if (miss !== undefined && t - miss < NOT_OWNER_CACHE_MS) return Promise.resolve(undefined);
      }
      const pending = building.get(identity);
      if (pending) return pending;
      const run = (entry ? renew(identity, entry) : open(identity)).finally(() => building.delete(identity));
      building.set(identity, run);
      return run;
    },

    async close() {
      clearInterval(sweeper);
      const all = [...entries.values()];
      entries.clear();
      await Promise.all(all.map((e) => e.world.close()));
    },
  };
}
