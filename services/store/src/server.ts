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
 * Or, with `DATABASE_URL` set, in a network Postgres instead (the hosted
 * engine's Supabase database); `REIN_DB_SCHEMA` optionally names the schema.
 * That mode requires `REIN_ENGINE_SIGNING_KEY` -- see `openReinStore`.
 * `REIN_MIGRATE_FROM=<pglite dir>` beside it copies that data dir into the
 * database first and verifies the copy (migrate.ts); the boot fails rather
 * than serve if the copy does not verify. It runs HERE, in the bin, because
 * on Railway the volume is only mounted into this container and PGlite admits
 * one process -- the engine being stopped for the redeploy is what makes the
 * copy safe. Harmless to leave set: a later boot finds the chain already
 * there and copies nothing.
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
  parseTrustProxy,
  rateLimitFromEnv,
  resolveHost,
  sandboxOptionsFromEnv,
  geoBlockFromEnv,
  screenerFromEnv,
  ScreeningService,
  type ApiKeyAuth,
  type GeoBlock,
  type RateLimitOptions,
  type SandboxOptions,
  type SanctionsScreener,
} from '@reinconsole/policy-engine';
import { openReinStore, type ReinStore } from './index.js';
import { installShutdown, pruneIntervalFromEnv, startPeriodicPrune } from './lifecycle.js';
import { migratePgliteToPostgres } from './migrate.js';

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
  /**
   * Rate limiting for the HTTP surface, and WHICH peers in front of it may
   * name the client through `X-Forwarded-For`. Both are forwarded verbatim to
   * `buildServer`; omitted, this engine has no limiter — see
   * `ServerOptions.rateLimit`, and `ServerOptions.trustProxy` for why the
   * second one identifies a peer rather than counting hops, and why `true`
   * leaves the per-IP limiter forgeable.
   */
  rateLimit?: RateLimitOptions;
  trustProxy?: boolean | string;
  /**
   * Sweep the TTL'd burn tables every this many ms (0 = never). The store
   * prunes once at open, which covers a service that restarts often and leaves
   * one that stays up accreting replay slots forever — exactly backwards for
   * the deployment this bin exists to be.
   */
  pruneIntervalMs?: number;
  /** The anonymous sandbox, forwarded to `buildServer` (needs `auth`). */
  sandbox?: SandboxOptions;
  /** See `ServerOptions.mainnetOrgs` in the engine. */
  mainnetOrgs?: readonly string[] | 'any';
  /** See `ServerOptions.geoBlock` in the engine. */
  geoBlock?: GeoBlock;
  /** Screens with this, recording into the store's `screenings` table. */
  screener?: SanctionsScreener;
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
  if (options.pruneIntervalMs !== 0) {
    stops.push(
      startPeriodicPrune({
        prune: () => store.prune(),
        ...(options.pruneIntervalMs !== undefined ? { intervalMs: options.pruneIntervalMs } : {}),
      }),
    );
  }
  const app = buildServer(engine, {
    ...(options.auth ? { auth: options.auth } : {}),
    ...(options.rateLimit ? { rateLimit: options.rateLimit } : {}),
    ...(options.trustProxy !== undefined ? { trustProxy: options.trustProxy } : {}),
    ...(options.sandbox ? { sandbox: options.sandbox } : {}),
    ...(options.mainnetOrgs ? { mainnetOrgs: options.mainnetOrgs } : {}),
    ...(options.geoBlock ? { geoBlock: options.geoBlock } : {}),
    ...(options.screener ? { screening: new ScreeningService(options.screener, store.screenings) } : {}),
  });
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

/**
 * The sandbox from env, drip included. x402-rails (and viem with it) is loaded
 * only when a faucet key is set: an engine that never drips never loads a
 * chain client.
 */
export async function sandboxFromEnv(
  env: NodeJS.ProcessEnv,
): Promise<{ options: SandboxOptions; describe: string } | undefined> {
  const options = sandboxOptionsFromEnv(env);
  if (!options) return undefined;
  const key = env['REIN_SANDBOX_FAUCET_KEY'];
  if (!key) return { options, describe: 'no drip (advisory only)' };
  if (!/^0x[0-9a-fA-F]{64}$/.test(key)) {
    throw new Error('REIN_SANDBOX_FAUCET_KEY must be 0x + 64 hex characters');
  }
  const { createUsdcFaucet, faucetAddress } = await import('@reinconsole/x402-rails');
  const amount = env['REIN_SANDBOX_DRIP_USDC'] || '0.05';
  const rpcUrl = env['REIN_SANDBOX_RPC_URL'] || undefined;
  const drip = createUsdcFaucet({
    privateKey: key as `0x${string}`,
    amount,
    ...(rpcUrl ? { rpcUrl } : {}),
  });
  return {
    options: { ...options, drip },
    describe: `drips ${amount} test USDC from ${faucetAddress(key as `0x${string}`)} (Base Sepolia)`,
  };
}

/** `REIN_MAINNET_ORGS`: comma-separated org ids, or `any`; unset = the engine's default. */
export function mainnetOrgsFromEnv(env: NodeJS.ProcessEnv): readonly string[] | 'any' | undefined {
  const raw = env['REIN_MAINNET_ORGS']?.trim();
  if (!raw) return undefined;
  if (raw === 'any') return 'any';
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** host[:port]/db of a connection string -- what a boot log may show. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return '(unparseable DATABASE_URL)';
  }
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
  const databaseUrl = process.env.DATABASE_URL || undefined;
  const schema = process.env.REIN_DB_SCHEMA || undefined;
  const dir = process.env.REIN_DATA_DIR ?? '.rein-data';
  const port = Number(process.env.PORT ?? 8787);
  // The store opens FIRST so the keys can be durable: `/v1/keys` issues them
  // at runtime, and an in-memory key store would drop every one at the next
  // restart while quietly resurrecting the ones an operator had revoked.
  // REIN_ENGINE_SIGNING_KEY moves the signing key out of the data dir (D1(c)).
  const signingKey = process.env.REIN_ENGINE_SIGNING_KEY;
  const migrateFrom = process.env.REIN_MIGRATE_FROM || undefined;
  if (migrateFrom) {
    if (!databaseUrl || !signingKey) {
      console.error('[rein] REIN_MIGRATE_FROM needs DATABASE_URL and REIN_ENGINE_SIGNING_KEY');
      process.exit(1);
    }
    try {
      await migratePgliteToPostgres({
        fromDir: migrateFrom,
        databaseUrl,
        signingKey,
        ...(schema ? { schema } : {}),
        log: (line) => console.log(line),
      });
    } catch (err) {
      console.error(err);
      process.exit(1);
    }
  }
  const store = await openReinStore({
    ...(databaseUrl ? { databaseUrl, ...(schema ? { schema } : {}) } : { dir }),
    ...(signingKey ? { signingKey } : {}),
  });
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
    // REIN_NOTIFY_ORGS narrows those channels to the operator's own orgs; the
    // agent registry is how an alarm, which names only an agent, finds its org.
    const orgOfAgent = (agentId: string) => store.agents.get(agentId)?.orgId;
    const approvals = approvalsFromEnv(process.env, { store: store.approvalStore, orgOfAgent });
    const liveness = livenessFromEnv(process.env, { store: store.livenessStore, orgOfAgent });
    // A bin is reachable by strangers and stays up for weeks, so it gets both
    // things an embedded engine has no use for: a rate limiter, and a
    // maintenance sweep that is not just the one at open.
    const rateLimit = rateLimitFromEnv(process.env);
    // The anonymous sandbox: REIN_SANDBOX=1. With REIN_SANDBOX_FAUCET_KEY it
    // also drips test USDC (Base Sepolia only -- see x402-rails faucet.ts).
    const sandbox = await sandboxFromEnv(process.env);
    if (sandbox && !auth) throw new Error('REIN_SANDBOX=1 needs an API key (REIN_ENGINE_API_KEY)');
    // REIN_MAINNET_ORGS (S95): which orgs `init --mainnet` may move to mainnet.
    // Unset with the sandbox on = none (the hosted engine; new orgs wait on
    // sanctions screening); unset without it = any (a self-hoster's engine).
    const mainnetOrgs = mainnetOrgsFromEnv(process.env);
    // S98, the same legal decision: where the sandbox serves strangers, the
    // engine refuses sanctioned territories (REIN_GEOBLOCK) and screens wallets
    // at claim and at mainnet (REIN_SANCTIONS_SCREENING). Both default ON with
    // the sandbox, so the hosted posture never rests on remembering a variable.
    const geoBlock = geoBlockFromEnv(process.env, sandbox !== undefined);
    const screener = screenerFromEnv(process.env, sandbox !== undefined);
    const trustProxy = parseTrustProxy(process.env['REIN_TRUST_PROXY']);
    if (geoBlock && trustProxy === false) {
      console.warn(
        '[rein] WARNING: the geo-block is on but REIN_TRUST_PROXY is off -- behind a proxy every request ' +
          'comes from the proxy, and nothing will ever be refused. Set REIN_TRUST_PROXY=1 on Railway.',
      );
    }
    const engine = await startPersistentEngine({
      store,
      port,
      host,
      approvals,
      liveness,
      ...(auth ? { auth } : {}),
      ...(rateLimit ? { rateLimit } : {}),
      trustProxy,
      pruneIntervalMs: pruneIntervalFromEnv(process.env),
      ...(sandbox ? { sandbox: sandbox.options } : {}),
      ...(mainnetOrgs ? { mainnetOrgs } : {}),
      ...(geoBlock ? { geoBlock } : {}),
      ...(screener ? { screener } : {}),
    });
    // Without this the process is SIGKILLed on every redeploy and the
    // write-behind tail dies with it — see lifecycle.ts. Installed only after
    // a successful listen: a boot that failed has its own cleanup below, and
    // a handler racing that would close the store twice.
    installShutdown({ name: 'rein-engine', close: () => engine.close() });
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
    // Never the URL itself: it carries the database password.
    const where = databaseUrl
      ? `database ${redactUrl(databaseUrl)}${schema ? ` schema ${schema}` : ''}`
      : `data dir ${dir}`;
    console.log(`[rein] ${where} — ${resumed}; signing key ${store.keySource}`);
    if (sandbox) console.log(`[rein] sandbox on -- ${sandbox.describe}`);
    console.log(
      geoBlock
        ? `[rein] geo-block on -- ${geoBlock.territories.join(', ')} (DB-IP edition ${geoBlock.edition})`
        : '[rein] geo-block off',
    );
    console.log(
      screener
        ? `[rein] sanctions screening on -- ${screener.describe}; ${store.screenings.count()} checks on record`
        : '[rein] sanctions screening off',
    );
  } catch (err) {
    // The store is open by now, so a refused bind must not leak the handle.
    await store.close().catch(() => undefined);
    console.error(err);
    process.exit(1);
  }
}
