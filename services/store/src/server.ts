#!/usr/bin/env node
/**
 * The persistent policy-engine service: the exact HTTP API of
 * @reinconsole/policy-engine's server, but agents, policies, spend history, the
 * signing key, and the hash-chained decision log live in a PGlite data
 * directory and survive restarts.
 *
 * Including that API's AUTHENTICATION. The in-memory engine's boot path
 * refuses to expose an unauthenticated engine on a public interface; this one
 * persists the very things that engine only held in RAM — the policies, the
 * spend ledger, the signing key — so it inherits the same rule rather than
 * quietly opting out of it. `REIN_ENGINE_API_KEY` is what turns it on.
 *
 * Run:
 *   $env:REIN_DATA_DIR = ".rein-data"   # optional, this is the default
 *   $env:REIN_ENGINE_API_KEY = "<secret>"
 *   pnpm --filter @reinconsole/store start
 */
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import {
  PolicyEngine,
  buildServer,
  authFromEnv,
  resolveHost,
  type ApiKeyAuth,
} from '@reinconsole/policy-engine';
import { openReinStore, type ReinStore } from './index.js';

export interface PersistentEngine {
  app: FastifyInstance;
  engine: PolicyEngine;
  store: ReinStore;
  close(): Promise<void>;
}

/** Compose a durable engine + HTTP server on top of a data directory. */
export async function startPersistentEngine(options: {
  /** Data directory to open. Mutually exclusive with `store`. */
  dir?: string;
  /**
   * An ALREADY-OPEN store to serve from, instead of a directory to open.
   *
   * This exists so a caller can build the auth layer against `store.apiKeys`
   * BEFORE the server starts — the standalone boot below has to, because
   * durable keys and the bind decision both need the store, and opening it
   * twice is not an option (one PGlite directory admits a single writer).
   * Ownership transfers: the returned `close()` closes it.
   */
  store?: ReinStore;
  port: number;
  host?: string;
  /**
   * API-key auth for the HTTP surface. Omit for an embedded or loopback-only
   * engine; the standalone boot below builds it from `REIN_ENGINE_API_KEY` and
   * will not bind a public interface without it.
   */
  auth?: ApiKeyAuth;
}): Promise<PersistentEngine> {
  if ((options.dir === undefined) === (options.store === undefined)) {
    throw new TypeError('startPersistentEngine: pass exactly one of { dir } or { store }');
  }
  const store = options.store ?? (await openReinStore({ dir: options.dir! }));
  const engine = new PolicyEngine(store);
  const app = buildServer(engine, { ...(options.auth ? { auth: options.auth } : {}) });
  try {
    await app.listen({ port: options.port, host: options.host ?? '127.0.0.1' });
  } catch (err) {
    // A failed listen (port in use) must not leak the open PGlite handle.
    await store.close().catch(() => undefined);
    throw err;
  }
  return {
    app,
    engine,
    store,
    close: async () => {
      try {
        await app.close();
      } finally {
        await store.close();
      }
    },
  };
}

// Start the server when run directly (tsx/node), not when imported.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const dir = process.env.REIN_DATA_DIR ?? '.rein-data';
  const port = Number(process.env.PORT ?? 8787);
  // The store opens FIRST so the keys can be durable: `/v1/keys` issues them
  // at runtime, and an in-memory key store would drop every one at the next
  // restart while quietly resurrecting the ones an operator had revoked.
  const store = await openReinStore({ dir });
  try {
    const auth = await authFromEnv(process.env, store.apiKeys);
    // Throws rather than binding a public interface without a key — the same
    // refusal the in-memory engine makes, and for the same reason: anyone who
    // can reach an open engine can rewrite policy and authorize spend.
    const { host, warning } = resolveHost(process.env, auth !== undefined);
    if (warning) console.warn(`[rein] ${warning}`);
    await startPersistentEngine({ store, port, host, ...(auth ? { auth } : {}) });
    const resumed = store.fresh
      ? 'fresh store'
      : `resumed ${store.resumedDecisions} decisions, ` +
        `${store.agents.list().length} agents, ${store.policies.list().length} policies, ` +
        `${store.resumedApiKeys} api keys`;
    console.log(
      `[rein] persistent policy-engine listening on http://${host}:${port} ` +
        `(auth: ${auth ? 'api-key' : 'none'})`,
    );
    console.log(`[rein] data dir ${dir} — ${resumed}`);
  } catch (err) {
    // The store is open by now, so a refused bind must not leak the handle.
    await store.close().catch(() => undefined);
    console.error(err);
    process.exit(1);
  }
}
