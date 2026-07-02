/**
 * A tiny framework-agnostic HTTP router for the console API. It speaks raw
 * node `http` so the exact same handler mounts as Vite dev middleware AND inside
 * the standalone production server — one implementation, no Fastify, no CORS
 * (the UI and API are always same-origin).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { World } from './world';

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * Returns a handler that resolves any `/api/*` request and reports whether it
 * did. A `false` return means "not mine" — let the caller fall through to the
 * next middleware (Vite) or to static file serving.
 */
export function createApiHandler(world: World) {
  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) return false;

    const method = req.method ?? 'GET';
    const parts = pathname.split('/').filter(Boolean); // e.g. ['api','agents','agt_x','freeze']

    // GET /api/state — full snapshot
    if (method === 'GET' && pathname === '/api/state') {
      sendJson(res, 200, world.getState());
      return true;
    }

    // GET /api/events — Server-Sent Events stream
    if (method === 'GET' && pathname === '/api/events') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      res.write(': connected\n\n');
      const unsubscribe = world.subscribe((ev) => {
        res.write(`event: ${ev.type}\n`);
        res.write(`data: ${JSON.stringify(ev)}\n\n`);
      });
      const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(heartbeat);
        unsubscribe();
      });
      return true;
    }

    // POST /api/demo/run
    if (method === 'POST' && pathname === '/api/demo/run') {
      const started = world.runDemo();
      sendJson(res, started ? 202 : 409, { started });
      return true;
    }

    // POST /api/agents/:id/(freeze|unfreeze|ping)
    if (method === 'POST' && parts[0] === 'api' && parts[1] === 'agents' && parts[3]) {
      const agentId = parts[2] ?? '';
      const action = parts[3];
      // All three are async now — freeze/unfreeze await the (possibly durable)
      // engine write before answering, so a 200 means the state change stuck.
      const act =
        action === 'freeze'
          ? world.freeze
          : action === 'unfreeze'
            ? world.unfreeze
            : action === 'ping'
              ? world.pingAgent
              : undefined;
      if (act) {
        act(agentId)
          .then((ok) => sendJson(res, ok ? (action === 'ping' ? 202 : 200) : 404, { ok }))
          .catch((err: unknown) => sendJson(res, 500, { error: String(err) }));
        return true;
      }
    }

    sendJson(res, 404, { error: 'not_found', path: pathname });
    return true;
  };
}
