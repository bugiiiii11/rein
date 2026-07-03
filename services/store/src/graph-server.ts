#!/usr/bin/env node
/**
 * The persistent reputation-graph service: the exact HTTP API of @reinconsole/graph's
 * server, but the evidence ledger and intent correlation map live in a PGlite
 * data directory and survive restarts. Scores are still recomputed on demand —
 * only the evidence behind them is persisted.
 *
 * Run:
 *   $env:REIN_GRAPH_DATA_DIR = ".rein-graph-data"   # optional, this is the default
 *   pnpm --filter @reinconsole/store start:graph
 *
 * Use a DIFFERENT data dir than the engine server (`.rein-data`): two processes
 * cannot share one PGlite directory. In a single process (e.g. the console
 * world), one `openReinStore({ dir })` backs both engine and graph at once.
 */
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { ReputationGraph, buildGraphServer } from '@reinconsole/graph';
import { openReinStore, type ReinStore } from './index.js';

export interface PersistentGraph {
  app: FastifyInstance;
  graph: ReputationGraph;
  store: ReinStore;
  close(): Promise<void>;
}

/** Compose a durable reputation graph + HTTP server on top of a data directory. */
export async function startPersistentGraphServer(options: {
  dir: string;
  port: number;
  host?: string;
  now?: () => Date;
}): Promise<PersistentGraph> {
  const store = await openReinStore({ dir: options.dir });
  const graph = new ReputationGraph({
    ledger: store.ledger,
    intents: store.intents,
    now: options.now,
  });
  const app = buildGraphServer(graph);
  try {
    await app.listen({ port: options.port, host: options.host ?? '0.0.0.0' });
  } catch (err) {
    // A failed listen (port in use) must not leak the open PGlite handle.
    await store.close().catch(() => undefined);
    throw err;
  }
  return {
    app,
    graph,
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
  const dir = process.env.REIN_GRAPH_DATA_DIR ?? '.rein-graph-data';
  const port = Number(process.env.PORT ?? 8788);
  const host = process.env.HOST ?? '0.0.0.0';
  startPersistentGraphServer({ dir, port, host })
    .then(({ store }) => {
      const resumed = store.fresh ? 'fresh store' : `resumed ${store.resumedSubjects} subjects`;
      console.log(`[rein] persistent graph listening on http://${host}:${port}`);
      console.log(`[rein] data dir ${dir} — ${resumed}`);
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
