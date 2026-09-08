/**
 * A1, console side: who may change the state of a live policy engine through
 * the dashboard. Reads stay open; every mutation is gated.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiHandler, resolveConsolePosture, type ApiOptions } from './api';
import type { World } from './world';
import type { ServerEvent } from './wire';

const frozen: string[] = [];

function fakeWorld(): World {
  return {
    getState: () => ({ marker: 'state' }),
    subscribe: (_l: (ev: ServerEvent) => void) => () => {},
    freeze: async (id: string) => {
      frozen.push(id);
      return true;
    },
    unfreeze: async () => true,
    pingAgent: async () => true,
    runDemo: () => true,
    close: async () => {},
  } as unknown as World;
}

let server: Server | undefined;

async function serve(options: ApiOptions): Promise<string> {
  const handle = createApiHandler(fakeWorld(), options);
  server = createServer((req, res) => {
    if (!handle(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  frozen.length = 0;
  const s = server;
  server = undefined;
  if (s) await new Promise<void>((resolve) => s.close(() => resolve()));
});

describe('console API auth', () => {
  it('leaves reads open while refusing an unauthenticated mutation', async () => {
    const base = await serve({ apiKey: 'console-secret' });

    expect((await fetch(`${base}/api/state`)).status).toBe(200);

    const res = await fetch(`${base}/api/agents/agt_x/freeze`, { method: 'POST' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
    // The refusal is real: the world was never touched.
    expect(frozen).toEqual([]);
  });

  it('accepts the mutation once the bearer matches', async () => {
    const base = await serve({ apiKey: 'console-secret' });
    const res = await fetch(`${base}/api/agents/agt_x/freeze`, {
      method: 'POST',
      headers: { authorization: 'Bearer console-secret' },
    });
    expect(res.status).toBe(200);
    expect(frozen).toEqual(['agt_x']);
  });

  it('refuses a wrong bearer', async () => {
    const base = await serve({ apiKey: 'console-secret' });
    const res = await fetch(`${base}/api/agents/agt_x/freeze`, {
      method: 'POST',
      headers: { authorization: 'Bearer wrong' },
    });
    expect(res.status).toBe(401);
    expect(frozen).toEqual([]);
  });

  it('refuses every mutation in read-only mode, key or not', async () => {
    const base = await serve({ readOnly: true, apiKey: 'console-secret' });

    for (const path of ['/api/agents/agt_x/freeze', '/api/agents/agt_x/ping', '/api/demo/run']) {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: 'Bearer console-secret' },
      });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: 'read_only' });
    }
    expect(frozen).toEqual([]);
    // The dashboard itself keeps working — that is the point of the mode.
    expect((await fetch(`${base}/api/state`)).status).toBe(200);
  });

  it('stays fully open when nothing is configured (local dev)', async () => {
    const base = await serve({});
    const res = await fetch(`${base}/api/agents/agt_x/freeze`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(frozen).toEqual(['agt_x']);
  });

  it('reports its posture so a UI can render honestly', async () => {
    const base = await serve({ readOnly: true });
    expect(await (await fetch(`${base}/api/control`)).json()).toEqual({
      writable: false,
      auth: 'none',
    });

    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    const open = await serve({ apiKey: 'k' });
    expect(await (await fetch(`${open}/api/control`)).json()).toEqual({
      writable: true,
      auth: 'bearer',
    });
  });
});

describe('resolveConsolePosture', () => {
  it('serves read-only when a public bind has no key', () => {
    const posture = resolveConsolePosture({});
    expect(posture.host).toBe('0.0.0.0');
    expect(posture.readOnly).toBe(true);
    expect(posture.warning).toContain('REIN_CONSOLE_API_KEY');
  });

  it('is writable on an explicit loopback bind', () => {
    const posture = resolveConsolePosture({ REIN_CONSOLE_HOST: '127.0.0.1' });
    expect(posture.readOnly).toBeUndefined();
    expect(posture.warning).toBeUndefined();
  });

  it('is writable anywhere once a key is set', () => {
    const posture = resolveConsolePosture({ REIN_CONSOLE_API_KEY: 'secret' });
    expect(posture.host).toBe('0.0.0.0');
    expect(posture.apiKey).toBe('secret');
    expect(posture.readOnly).toBeUndefined();
  });

  it('honours an explicit read-only request even with a key', () => {
    const posture = resolveConsolePosture({
      REIN_CONSOLE_API_KEY: 'secret',
      REIN_CONSOLE_READONLY: '1',
      REIN_CONSOLE_HOST: '127.0.0.1',
    });
    expect(posture.readOnly).toBe(true);
    expect(posture.apiKey).toBeUndefined();
  });
});
