/**
 * The console HTTP/SSE contract, tested against a scripted fake World over a
 * real `node:http` server — the handler's routing, status mapping and SSE
 * framing are what the React app depends on, independent of world internals.
 */
import { createServer, get, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApiHandler } from './api';
import type { World } from './world';
import type { ServerEvent } from './wire';

const STATE = { marker: 'console-state' };

/** A World stub with observable seams. Only the handler's contract matters. */
function makeFakeWorld() {
  const listeners = new Set<(ev: ServerEvent) => void>();
  const calls: string[] = [];
  let demoRunning = false;
  let stateReads = 0;
  const world = {
    getState: () => {
      stateReads += 1;
      return STATE;
    },
    subscribe: (l: (ev: ServerEvent) => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    freeze: async (id: string) => {
      calls.push(`freeze:${id}`);
      if (id === 'agt_boom') throw new Error('store exploded');
      return id === 'agt_known';
    },
    unfreeze: async (id: string) => {
      calls.push(`unfreeze:${id}`);
      return id === 'agt_known';
    },
    pingAgent: async (id: string) => {
      calls.push(`ping:${id}`);
      return id === 'agt_known';
    },
    runDemo: () => {
      if (demoRunning) return false;
      demoRunning = true;
      return true;
    },
    close: async () => {},
  };
  return {
    world: world as unknown as World,
    listeners,
    calls,
    get stateReads() {
      return stateReads;
    },
  };
}

let server: Server;
let base: string;
let fake: ReturnType<typeof makeFakeWorld>;

beforeAll(async () => {
  fake = makeFakeWorld();
  const handle = createApiHandler(fake.world);
  server = createServer((req, res) => {
    if (handle(req, res)) return;
    // The handler declined — the caller (Vite / static files) takes over.
    res.writeHead(418);
    res.end('fell through');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

describe('routing', () => {
  it('GET /api/state returns the world snapshot, uncacheable', async () => {
    const res = await fetch(`${base}/api/state`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual(STATE);
  });

  it('GET /api/health answers without reading the world', async () => {
    // The healthcheck used to be /api/state: a full snapshot, serialized on
    // every probe and free to anyone. Liveness must cost -- and reveal -- nothing.
    const reads = fake.stateReads;
    const res = await fetch(`${base}/api/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = (await res.json()) as { status: string; startedAt: string; uptimeMs: number };
    expect(body.status).toBe('ok');
    expect(Number.isNaN(Date.parse(body.startedAt))).toBe(false);
    expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
    expect(fake.stateReads).toBe(reads);
  });

  /**
   * `/api/status` exists only on a console that is a client of a hosted
   * engine. A console running its own world has no link to report on, and a
   * fabricated "ok" there would be the one thing this route exists to stop.
   */
  it('GET /api/status 404s on a console that runs its own world', async () => {
    const res = await fetch(`${base}/api/status`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'no_remote_engine' });
  });

  it('non-/api/ paths fall through to the next middleware', async () => {
    for (const path of ['/', '/index.html', '/apix', '/api']) {
      const res = await fetch(`${base}${path}`);
      expect(res.status).toBe(418);
    }
  });

  it('unknown /api/ paths and methods 404 with the not_found envelope', async () => {
    const res = await fetch(`${base}/api/nope`);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_found', path: '/api/nope' });
    // Right path, wrong method: state is GET-only.
    const post = await fetch(`${base}/api/state`, { method: 'POST' });
    expect(post.status).toBe(404);
  });
});

describe('demo + agent actions', () => {
  it('POST /api/demo/run: 202 on start, 409 while already running', async () => {
    const first = await fetch(`${base}/api/demo/run`, { method: 'POST' });
    expect(first.status).toBe(202);
    expect(await first.json()).toEqual({ started: true });
    const second = await fetch(`${base}/api/demo/run`, { method: 'POST' });
    expect(second.status).toBe(409);
    expect(await second.json()).toEqual({ started: false });
  });

  it('freeze/unfreeze answer 200 only after the world write resolved true', async () => {
    for (const action of ['freeze', 'unfreeze'] as const) {
      const ok = await fetch(`${base}/api/agents/agt_known/${action}`, { method: 'POST' });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ ok: true });
      const missing = await fetch(`${base}/api/agents/agt_ghost/${action}`, { method: 'POST' });
      expect(missing.status).toBe(404);
      expect(await missing.json()).toEqual({ ok: false });
    }
    expect(fake.calls).toContain('freeze:agt_known');
    expect(fake.calls).toContain('unfreeze:agt_ghost');
  });

  it('ping answers 202 (accepted, outcome lands on the feed), 404 for unknown', async () => {
    const ok = await fetch(`${base}/api/agents/agt_known/ping`, { method: 'POST' });
    expect(ok.status).toBe(202);
    const missing = await fetch(`${base}/api/agents/agt_ghost/ping`, { method: 'POST' });
    expect(missing.status).toBe(404);
  });

  it('a rejected world write surfaces as 500, not a hung request', async () => {
    const res = await fetch(`${base}/api/agents/agt_boom/freeze`, { method: 'POST' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('store exploded');
  });

  it('unknown agent actions 404 rather than dispatching', async () => {
    const res = await fetch(`${base}/api/agents/agt_known/detonate`, { method: 'POST' });
    expect(res.status).toBe(404);
    expect(fake.calls).not.toContain('detonate:agt_known');
  });
});

describe('SSE stream', () => {
  it('frames events as `event:`/`data:` blocks and detaches on close', async () => {
    const chunks: string[] = [];
    const req = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
      get(`${base}/api/events`, resolve).on('error', reject);
    });
    expect(req.statusCode).toBe(200);
    expect(req.headers['content-type']).toBe('text/event-stream');
    req.on('data', (c: Buffer) => chunks.push(c.toString('utf8')));

    // The preamble comment arrives first, then a pushed event, framed per spec.
    await new Promise((r) => setTimeout(r, 50));
    expect(fake.listeners.size).toBe(1);
    const ev: ServerEvent = { type: 'demo', demo: { running: true, phase: 'test' } };
    for (const l of fake.listeners) l(ev);
    await new Promise((r) => setTimeout(r, 50));
    const text = chunks.join('');
    expect(text.startsWith(': connected\n\n')).toBe(true);
    expect(text).toContain('event: demo\n');
    expect(text).toContain(`data: ${JSON.stringify(ev)}\n\n`);

    // Closing the request must unsubscribe (and stop the heartbeat with it).
    req.destroy();
    await new Promise((r) => setTimeout(r, 100));
    expect(fake.listeners.size).toBe(0);
  });

  it('caps concurrent streams and hands the slot back when one closes', async () => {
    // An uncapped /api/events is the cheapest way to make a PUBLIC dashboard
    // hold unbounded memory: the feed is the read-only half that stays open on
    // purpose, so no credential is involved, and the console keeps a response
    // object plus a subscription per stream.
    const capped = makeFakeWorld();
    const handle = createApiHandler(capped.world, { maxSseClients: 2 });
    const server2 = createServer((req, res) => {
      if (!handle(req, res)) {
        res.writeHead(418);
        res.end();
      }
    });
    await new Promise<void>((r) => server2.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server2.address() as AddressInfo).port}/api/events`;
    const open = (): Promise<import('node:http').IncomingMessage> =>
      new Promise((resolve, reject) => get(url, resolve).on('error', reject));

    try {
      const first = await open();
      const second = await open();
      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      const third = await open();
      // 503, not 429: the refusal is about this server's capacity, not about
      // anything this client did — it may be its first request.
      expect(third.statusCode).toBe(503);
      expect(third.headers['retry-after']).toBe('30');
      third.resume();

      // A closed stream returns its slot; a cap that only ever counted up
      // would make the console degrade permanently after a busy afternoon.
      first.destroy();
      await new Promise((r) => setTimeout(r, 100));
      const fourth = await open();
      expect(fourth.statusCode).toBe(200);
      second.destroy();
      fourth.destroy();
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });
});

describe('GET /api/status on a remote-engine console', () => {
  let statusServer: Server;
  let statusBase: string;
  let reported: Record<string, unknown> = { engine: 'https://engine.example', state: 'ok' };

  beforeAll(async () => {
    const handle = createApiHandler(makeFakeWorld().world, { status: () => reported });
    statusServer = createServer((req, res) => {
      if (handle(req, res)) return;
      res.writeHead(418);
      res.end('fell through');
    });
    await new Promise<void>((r) => statusServer.listen(0, '127.0.0.1', r));
    statusBase = `http://127.0.0.1:${(statusServer.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      statusServer.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('reports which engine, and whether the last poll reached it', async () => {
    const res = await fetch(`${statusBase}/api/status`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ engine: 'https://engine.example', state: 'ok' });
  });

  it('admits staleness rather than hiding it', async () => {
    reported = {
      engine: 'https://engine.example',
      state: 'unreachable',
      error: 'GET /health -> 502',
      lastDecisionAt: '2026-09-19T00:00:00.000Z',
    };
    const body = (await (await fetch(`${statusBase}/api/status`)).json()) as { state: string };
    expect(body.state).toBe('unreachable');
  });

  it('needs no credential — none of it is a secret', async () => {
    const res = await fetch(`${statusBase}/api/status`, { headers: {} });
    expect(res.status).toBe(200);
  });
});
