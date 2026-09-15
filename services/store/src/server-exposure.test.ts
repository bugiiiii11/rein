import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { ApiKeyAuth } from '@reinconsole/policy-engine';
import { openDb } from './db.js';
import { resolveGraphHost } from './graph-server.js';
import { startPersistentEngine, type PersistentEngine } from './server.js';

/**
 * D1: the durable services are the ones worth reaching. The in-memory engine
 * has always refused to expose itself without a key; these are the tests that
 * the PERSISTENT bins — which hold the policies, the spend ledger and the
 * signing key on disk — do not quietly opt out of that.
 */

const dirs: string[] = [];
const running: PersistentEngine[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rein-exposure-'));
  dirs.push(dir);
  return dir;
}

afterAll(async () => {
  for (const engine of running) await engine.close().catch(() => undefined);
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
});

describe('resolveGraphHost', () => {
  it('binds loopback by default — the graph API has no auth at all', () => {
    expect(resolveGraphHost({}).host).toBe('127.0.0.1');
    expect(resolveGraphHost({ HOST: 'localhost' }).host).toBe('localhost');
  });

  it('refuses a public bind, naming the way out', () => {
    expect(() => resolveGraphHost({ HOST: '0.0.0.0' })).toThrow(/REIN_GRAPH_PUBLIC=1/);
    expect(() => resolveGraphHost({ HOST: '10.0.0.4' })).toThrow(/no authentication/);
  });

  it('opts in loudly, never silently', () => {
    const resolved = resolveGraphHost({ HOST: '0.0.0.0', REIN_GRAPH_PUBLIC: '1' });
    expect(resolved.host).toBe('0.0.0.0');
    expect(resolved.warning).toMatch(/unauthenticated/);
    // The opt-in is the string "1", not any truthy-looking value.
    expect(() => resolveGraphHost({ HOST: '0.0.0.0', REIN_GRAPH_PUBLIC: 'true' })).toThrow();
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
