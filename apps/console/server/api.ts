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

/** Read a JSON body, capped — an unbounded read is a free memory exhaust. */
const MAX_BODY_BYTES = 16_384;

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('body must be a JSON object');
  }
  return parsed as Record<string, unknown>;
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
  const startedAt = new Date();

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

    // GET /api/health — what the platform healthcheck polls. It touches
    // nothing: the probe used to hit /api/state, which serialized the whole
    // world every few seconds and made a full state dump the cheapest request
    // on the box. Liveness of the process is all a probe is entitled to.
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        startedAt: startedAt.toISOString(),
        uptimeMs: Date.now() - startedAt.getTime(),
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

    // POST /api/escalations/:decisionId/grant — submit a SIGNED verdict for a
    // parked payment. The console never signs: it carries bytes an approver
    // produced wherever their private key lives, and the engine verifies them
    // against a registered key. Treated as a mutation (and so refused outright
    // on a read-only console) not because the signature needs protecting — it
    // verifies or it does not — but because a public dashboard should not be a
    // submission endpoint for anyone who finds it.
    if (
      method === 'POST' &&
      parts[0] === 'api' &&
      parts[1] === 'escalations' &&
      parts[2] &&
      parts[3] === 'grant'
    ) {
      const decisionId = parts[2];
      readJson(req)
        .then((body) =>
          world.submitGrant({
            decisionId,
            intentHash: String(body['intentHash'] ?? ''),
            verdict: body['verdict'] === 'reject' ? 'reject' : 'approve',
            approverKeyId: String(body['approverKeyId'] ?? ''),
            signature: String(body['signature'] ?? ''),
          }),
        )
        .then((result) => sendJson(res, 200, result))
        .catch((err: unknown) => {
          // Every refusal is a reason, never a silent no-op: the request stays
          // parked and the submitter is told which check it failed.
          const e = err as { status?: number; code?: string; message?: string };
          const status = typeof e.status === 'number' ? e.status : 400;
          sendJson(res, status, {
            error: e.code ?? 'bad_request',
            message: e.message ?? String(err),
          });
        });
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
