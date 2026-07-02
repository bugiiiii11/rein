#!/usr/bin/env node
/**
 * The persistent policy-engine service: the exact HTTP API of
 * @rein/policy-engine's server, but agents, policies, spend history, the
 * signing key, and the hash-chained decision log live in a PGlite data
 * directory and survive restarts.
 *
 * Run:
 *   $env:REIN_DATA_DIR = ".rein-data"   # optional, this is the default
 *   pnpm --filter @rein/store start
 */
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { PolicyEngine, buildServer } from '@rein/policy-engine';
import { openReinStore, type ReinStore } from './index.js';

export interface PersistentEngine {
  app: FastifyInstance;
  engine: PolicyEngine;
  store: ReinStore;
  close(): Promise<void>;
}

/** Compose a durable engine + HTTP server on top of a data directory. */
export async function startPersistentEngine(options: {
  dir: string;
  port: number;
  host?: string;
}): Promise<PersistentEngine> {
  const store = await openReinStore({ dir: options.dir });
  const engine = new PolicyEngine(store);
  const app = buildServer(engine);
  try {
    await app.listen({ port: options.port, host: options.host ?? '0.0.0.0' });
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
  const host = process.env.HOST ?? '0.0.0.0';
  startPersistentEngine({ dir, port, host })
    .then(({ store }) => {
      const resumed = store.fresh
        ? 'fresh store'
        : `resumed ${store.resumedDecisions} decisions, ` +
          `${store.agents.list().length} agents, ${store.policies.list().length} policies`;
      console.log(`[rein] persistent policy-engine listening on http://${host}:${port}`);
      console.log(`[rein] data dir ${dir} — ${resumed}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
