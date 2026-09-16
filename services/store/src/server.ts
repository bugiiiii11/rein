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
import type { AddressInfo } from 'node:net';
import type { FastifyInstance } from 'fastify';
import {
  ApprovalService,
  approvalsFromEnv,
  authFromEnv,
  buildServer,
  livenessFromEnv,
  LivenessMonitor,
  PolicyEngine,
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
  /** Forwarded to `openReinStore` with `dir`; ignored with `store` (already open). */
  signingKey?: string;
  /**
   * The approval tier and the dead-man monitor. The standalone boot builds
   * both from env on the store's durable halves (`approvalStore`,
   * `livenessStore`). Omit them and the engine has no approval service -- a
   * parked payment then has nowhere to park and `/v1/approvals` answers 404 --
   * so an embedded caller that wants escalations composes its own. Their
   * sweepers start with the server and stop with `close()`.
   */
  approvals?: ApprovalService;
  liveness?: LivenessMonitor;
}): Promise<PersistentEngine> {
  if ((options.dir === undefined) === (options.store === undefined)) {
    throw new TypeError('startPersistentEngine: pass exactly one of { dir } or { store }');
  }
  const store =
    options.store ??
    (await openReinStore({
      dir: options.dir!,
      ...(options.signingKey ? { signingKey: options.signingKey } : {}),
    }));
  const engine = new PolicyEngine({
    ...store,
    ...(options.approvals ? { approvals: options.approvals } : {}),
    ...(options.liveness ? { liveness: options.liveness } : {}),
  });
  // Nothing else will ever expire a parked payment or notice a silent agent.
  const stops: Array<() => void> = [];
  if (options.approvals) stops.push(engine.startExpirySweeper());
  if (options.liveness) stops.push(engine.startLivenessSweeper());
  const app = buildServer(engine, { ...(options.auth ? { auth: options.auth } : {}) });
  try {
    await app.listen({ port: options.port, host: options.host ?? '127.0.0.1' });
  } catch (err) {
    // A failed listen (port in use) must not leak the open PGlite handle.
    for (const stop of stops) stop();
    await store.close().catch(() => undefined);
    throw err;
  }
  return {
    app,
    engine,
    store,
    close: async () => {
      for (const stop of stops) stop();
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
  // REIN_ENGINE_SIGNING_KEY moves the signing key out of the data dir (D1(c)).
  const signingKey = process.env.REIN_ENGINE_SIGNING_KEY;
  const store = await openReinStore({ dir, ...(signingKey ? { signingKey } : {}) });
  try {
    const auth = await authFromEnv(process.env, store.apiKeys);
    // Throws rather than binding a public interface without a key — the same
    // refusal the in-memory engine makes, and for the same reason: anyone who
    // can reach an open engine can rewrite policy and authorize spend.
    const { host, warning } = resolveHost(process.env, auth !== undefined);
    if (warning) console.warn(`[rein] ${warning}`);
    // The approval tier and the dead-man run here too, on the durable halves:
    // without them a parked payment has nowhere to park and a silent agent is
    // never noticed -- the two things a restart must not forget. Same env as
    // the in-memory engine: REIN_ESCALATION_TTL_MS, REIN_TELEGRAM_BOT_TOKEN +
    // REIN_TELEGRAM_CHAT_ID (both or neither -- half is a startup error).
    const approvals = approvalsFromEnv(process.env, { store: store.approvalStore });
    const liveness = livenessFromEnv(process.env, { store: store.livenessStore });
    const engine = await startPersistentEngine({
      store,
      port,
      host,
      approvals,
      liveness,
      ...(auth ? { auth } : {}),
    });
    // The BOUND port, not the requested one: with PORT=0 the OS picks, and the
    // boot line is how a supervisor or a test discovers where the engine went.
    const bound = (engine.app.server.address() as AddressInfo).port;
    const resumed = store.fresh
      ? 'fresh store'
      : `resumed ${store.resumedDecisions} decisions, ` +
        `${store.agents.list().length} agents, ${store.policies.list().length} policies, ` +
        `${store.resumedApiKeys} api keys`;
    console.log(
      `[rein] persistent policy-engine listening on http://${host}:${bound} ` +
        `(auth: ${auth ? 'api-key' : 'none'})`,
    );
    console.log(`[rein] data dir ${dir} — ${resumed}; signing key ${store.keySource}`);
  } catch (err) {
    // The store is open by now, so a refused bind must not leak the handle.
    await store.close().catch(() => undefined);
    console.error(err);
    process.exit(1);
  }
}
