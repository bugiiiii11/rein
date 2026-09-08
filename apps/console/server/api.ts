/**
 * A tiny framework-agnostic HTTP router for the console API. It speaks raw
 * node `http` so the exact same handler mounts as Vite dev middleware AND inside
 * the standalone production server — one implementation, no Fastify, no CORS
 * (the UI and API are always same-origin).
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { World } from './world';

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(body);
}

export interface ApiOptions {
  /**
   * Bearer secret every mutating route demands. Unset means an open console —
   * fine on a laptop, which is why `standalone.ts` refuses to run that way on
   * a public interface.
   */
  apiKey?: string;
  /**
   * Refuse every mutation regardless of credentials. This is the posture for a
   * public read-only dashboard: the state and event stream stay visible, and
   * freeze/unfreeze/ping/demo cannot be reached at all.
   */
  readOnly?: boolean;
}

/** Constant-time secret comparison over digests, so length and prefix do not leak. */
function secretMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function bearerOf(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  const match = value ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
  return match?.[1]?.trim();
}

/**
 * Returns a handler that resolves any `/api/*` request and reports whether it
 * did. A `false` return means "not mine" — let the caller fall through to the
 * next middleware (Vite) or to static file serving.
 */
export function createApiHandler(world: World, options: ApiOptions = {}) {
  const writable = options.readOnly !== true;

  /**
   * Gate every state change. Returns true when the request was refused (and
   * answered) — read-only mode is 403 whatever you present, a missing or wrong
   * bearer is 401 with a challenge. Never a silent no-op.
   */
  function refuseMutation(req: IncomingMessage, res: ServerResponse): boolean {
    if (!writable) {
      sendJson(res, 403, { error: 'read_only', message: 'this console is read-only' });
      return true;
    }
    if (options.apiKey === undefined) return false;
    const presented = bearerOf(req);
    if (presented === undefined || !secretMatches(presented, options.apiKey)) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="rein-console"');
      sendJson(res, 401, { error: 'unauthorized', message: 'missing or invalid console API key' });
      return true;
    }
    return false;
  }

  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    if (!pathname.startsWith('/api/')) return false;

    const method = req.method ?? 'GET';
    const parts = pathname.split('/').filter(Boolean); // e.g. ['api','agents','agt_x','freeze']

    // GET /api/control — the posture, so a UI can render honestly instead of
    // offering buttons that will 401.
    if (method === 'GET' && pathname === '/api/control') {
      sendJson(res, 200, {
        writable,
        auth: options.apiKey === undefined ? 'none' : 'bearer',
      });
      return true;
    }

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

    // Everything below this line changes state.
    if (method !== 'GET' && refuseMutation(req, res)) return true;

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

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);

export interface ConsolePosture extends ApiOptions {
  host: string;
  warning?: string;
}

/**
 * Decide what the standalone console may do, from the environment alone.
 *
 * One rule, fail-closed: a console is writable only on an EXPLICIT signal —
 * either an API key, or a deliberate loopback bind. Anything else (which is
 * every public deployment that has not been configured yet) serves the
 * dashboard read-only rather than exposing freeze/unfreeze/demo to the
 * internet. The site stays up; the controls do not answer strangers.
 */
export function resolveConsolePosture(env: NodeJS.ProcessEnv): ConsolePosture {
  const host = env['REIN_CONSOLE_HOST']?.trim() || env['HOST']?.trim() || '0.0.0.0';
  const apiKey = env['REIN_CONSOLE_API_KEY']?.trim();
  const forcedReadOnly = env['REIN_CONSOLE_READONLY']?.trim() === '1';

  if (forcedReadOnly) return { host, readOnly: true };
  if (apiKey) return { host, apiKey };
  if (LOOPBACK.has(host)) return { host };
  return {
    host,
    readOnly: true,
    warning:
      `no REIN_CONSOLE_API_KEY set and binding ${host} — serving READ-ONLY. ` +
      'Set REIN_CONSOLE_API_KEY to enable the controls, or REIN_CONSOLE_HOST=127.0.0.1 for local use.',
  };
}
