import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiKeyAuth, approvalsFromEnv, authFromEnv, livenessFromEnv } from '@reinconsole/policy-engine';
import { openDb } from './db.js';
import { resolveGraphHost, startPersistentGraphServer, type PersistentGraph } from './graph-server.js';
import { startPersistentEngine, type PersistentEngine } from './server.js';
import { openReinStore, type ReinStore } from './index.js';

/**
 * D1: the durable services are the ones worth reaching. The in-memory engine
 * has always refused to expose itself without a key; these are the tests that
 * the PERSISTENT bins — which hold the policies, the spend ledger and the
 * signing key on disk — do not quietly opt out of that.
 */

const dirs: string[] = [];
const running: PersistentEngine[] = [];
const runningGraphs: PersistentGraph[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rein-exposure-'));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const engine of running) await engine.close().catch(() => undefined);
  for (const graph of runningGraphs) await graph.close().catch(() => undefined);
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe('the persistent engine service', () => {
  it('carries the API-key auth through to the HTTP surface', async () => {
    const auth = new ApiKeyAuth();
    const { secret } = await auth.issue({ name: 'test', scopes: ['admin'] });
    const engine = await startPersistentEngine({ dir: tempDir(), port: 0, auth });
    running.push(engine);

    const port = (engine.app.server.address() as AddressInfo).port;
    const anonymous = await fetch(`http://127.0.0.1:${port}/v1/agents`);
    expect(anonymous.status).toBe(401);

    const keyed = await fetch(`http://127.0.0.1:${port}/v1/agents`, {
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(keyed.status).toBe(200);
  });

  it('binds loopback when no host is given, rather than every interface', async () => {
    const engine = await startPersistentEngine({ dir: tempDir(), port: 0 });
    running.push(engine);
    expect((engine.app.server.address() as AddressInfo).address).toBe('127.0.0.1');
  });

  it('serves the approval tier when composed with it, exactly as the standalone boot does', async () => {
    const store = await openReinStore({ dir: tempDir() });
    const engine = await startPersistentEngine({
      store,
      port: 0,
      approvals: approvalsFromEnv({}, { store: store.approvalStore }),
      liveness: livenessFromEnv({}, { store: store.livenessStore }),
    });
    running.push(engine);
    const port = (engine.app.server.address() as AddressInfo).port;
    // Until S53 the durable bin composed no tier at all, so this route was the
    // 404 the MCP server reports as NOT SUPPORTED -- on exactly the deployment
    // whose parked payments were meant to survive a restart.
    expect((await fetch(`http://127.0.0.1:${port}/v1/approvals`)).status).toBe(200);
  });

  it('has no approval tier unless one is composed', async () => {
    const engine = await startPersistentEngine({ dir: tempDir(), port: 0 });
    running.push(engine);
    const port = (engine.app.server.address() as AddressInfo).port;
    expect((await fetch(`http://127.0.0.1:${port}/v1/approvals`)).status).toBe(404);
  });
});

describe('resolveGraphHost', () => {
  it('binds loopback by default — an unkeyed graph is not reachable by accident', () => {
    expect(resolveGraphHost({}).host).toBe('127.0.0.1');
    expect(resolveGraphHost({ HOST: 'localhost' }).host).toBe('localhost');
  });

  it('refuses a public bind, naming both ways out', () => {
    expect(() => resolveGraphHost({ HOST: '0.0.0.0' })).toThrow(/REIN_GRAPH_PUBLIC=1/);
    expect(() => resolveGraphHost({ HOST: '0.0.0.0' })).toThrow(/REIN_GRAPH_API_KEY/);
    expect(() => resolveGraphHost({ HOST: '10.0.0.4' })).toThrow(/no authentication/);
  });

  it('opts in loudly, never silently', () => {
    const resolved = resolveGraphHost({ HOST: '0.0.0.0', REIN_GRAPH_PUBLIC: '1' });
    expect(resolved.host).toBe('0.0.0.0');
    expect(resolved.warning).toMatch(/unauthenticated/);
    // The opt-in is the string "1", not any truthy-looking value.
    expect(() => resolveGraphHost({ HOST: '0.0.0.0', REIN_GRAPH_PUBLIC: 'true' })).toThrow();
  });

  it('takes a key as payment for a public bind, and says nothing alarming', () => {
    // D1(a): the graph finally has something to trade. A keyed graph binds
    // public with no warning, because its writes are no longer anonymous —
    // exactly the deal the engine's resolveHost offers.
    expect(resolveGraphHost({ HOST: '0.0.0.0' }, true)).toEqual({ host: '0.0.0.0' });
    expect(resolveGraphHost({}, true).host).toBe('0.0.0.0');
  });
});

describe('the persistent graph bin', () => {
  it('gates writes and leaves reads open when a key is configured', async () => {
    const auth = new ApiKeyAuth();
    const { secret } = await auth.issue({ name: 'indexer', scopes: ['report'] });
    const graph = await startPersistentGraphServer({ dir: tempDir(), port: 0, auth });
    runningGraphs.push(graph);

    const anonymous = await graph.app.inject({ method: 'POST', url: '/v1/events', payload: {} });
    expect(anonymous.statusCode).toBe(401);
    // Reads never needed a key, and still do not.
    expect((await graph.app.inject({ method: 'GET', url: '/v1/scores' })).statusCode).toBe(200);
    expect((await graph.app.inject({ method: 'GET', url: '/health' })).json().auth).toBe('api-key');
    // The key gets past the gate; the 400 is the empty payload, which is proof
    // enough that authentication no longer stands in the way.
    const keyed = await graph.app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${secret}` },
      payload: {},
    });
    expect(keyed.statusCode).toBe(400);
  });
});

describe('the data directory', () => {
  it('is created 0700 — the engine signing key lives in it', async () => {
    const parent = tempDir();
    const dir = join(parent, 'nested', 'data');
    const db = await openDb(dir);
    await db.close();
    if (process.platform === 'win32') return; // POSIX modes are not enforced there
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

/**
 * D1(b): the engine MINTS keys at runtime (`POST /v1/keys`), so its key store
 * is state, not configuration. With the in-memory default every key issued
 * through the API stopped working at the next restart, and a key an operator
 * REVOKED after a leak authenticated again — both silently, neither in a log.
 */
describe('the persistent engine service, across a restart', () => {
  const issueKeyVia = async (port: number, adminSecret: string, scopes: string[]) => {
    const res = await fetch(`http://127.0.0.1:${port}/v1/keys`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${adminSecret}` },
      body: JSON.stringify({ name: 'minted-at-runtime', scopes }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { key: { id: string }; secret: string };
  };

  const startOn = async (store: ReinStore) => {
    const auth = new ApiKeyAuth({ store: store.apiKeys });
    const engine = await startPersistentEngine({ store, port: 0, auth });
    running.push(engine);
    return { engine, auth, port: (engine.app.server.address() as AddressInfo).port };
  };

  it('keeps a key minted through the API, and keeps a revoked one dead', async () => {
    const dir = tempDir();

    const first = await openReinStore({ dir });
    const boot = await startOn(first);
    const { secret: adminSecret } = await boot.auth.issue({ name: 'env', scopes: ['admin'] });
    const keep = await issueKeyVia(boot.port, adminSecret, ['read']);
    const leaked = await issueKeyVia(boot.port, adminSecret, ['read']);
    const revoked = await fetch(`http://127.0.0.1:${boot.port}/v1/keys/${leaked.key.id}/revoke`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminSecret}` },
    });
    expect(revoked.status).toBe(200);
    await boot.engine.close();

    const resumed = await openReinStore({ dir });
    expect(resumed.resumedApiKeys).toBe(3); // env + the two minted
    const again = await startOn(resumed);

    const survives = await fetch(`http://127.0.0.1:${again.port}/v1/agents`, {
      headers: { authorization: `Bearer ${keep.secret}` },
    });
    expect(survives.status).toBe(200);

    // The one that matters: a revocation is a write, and it stuck.
    const dead = await fetch(`http://127.0.0.1:${again.port}/v1/agents`, {
      headers: { authorization: `Bearer ${leaked.secret}` },
    });
    expect(dead.status).toBe(401);
    expect(await dead.json()).toMatchObject({ error: 'key_revoked' });
  });

  /**
   * The env secret is configuration and is re-seeded every boot, so seeding
   * has to be idempotent: a new record per boot would accrete a row each time
   * AND shadow the previous one in the secret-hash index.
   */
  it('re-seeds the env secret without accreting a row per boot', async () => {
    const dir = tempDir();
    const env = { REIN_ENGINE_API_KEY: 'env-secret-abcdefghij' } as NodeJS.ProcessEnv;

    const a = await openReinStore({ dir });
    expect(await authFromEnv(env, a.apiKeys)).toBeDefined();
    expect(a.apiKeys.list()).toHaveLength(1);
    await a.close();

    const b = await openReinStore({ dir });
    const auth = await authFromEnv(env, b.apiKeys);
    expect(b.apiKeys.list()).toHaveLength(1);
    expect(auth!.authenticate({ authorization: 'Bearer env-secret-abcdefghij' }, 'admin').name).toBe(
      'env-key-1',
    );
    await b.close();
  });
});
