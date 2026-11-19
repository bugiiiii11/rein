/**
 * The operator pass (docs/legal/decisions.md, 2026-11-18): how the operator's
 * own team reaches the hosted console from a territory the service is not
 * offered in (the EEA, the UK). The geo gate refuses every request from
 * there, the sign-in page included, so a session cannot be the way in.
 *
 * `/operator` is an unlinked page that takes an engine API key. The console
 * asks the engine whose key it is (`GET /v1/whoami`) and, if the key is
 * unscoped with `admin` or belongs to an org in `REIN_GEOBLOCK_OPERATOR_ORGS`,
 * sets a signed cookie. A browser holding that cookie passes the gate for
 * not-offered territories. Nothing else changes: sign-in is still needed to
 * see an org.
 *
 * What it is not: it is by key and org only, so no address is listed and no
 * personal data is collected for it; it never opens a SANCTIONED territory
 * (the gate does not consult it there); and the key is used once, in a POST
 * body, and is not stored -- the cookie carries the org id and an expiry.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { GEOBLOCK_STATUS } from '@reinconsole/policy-engine';
import { readCookie } from './signin';

export const OPERATOR_COOKIE = 'rein_operator';
export const OPERATOR_PATH = '/operator';
const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 2_048;
/** Across everybody: this page has a handful of legitimate users. */
const MAX_ATTEMPTS_PER_MINUTE = 5;

export interface OperatorPassOptions {
  /** The console's session secret; the pass signs under a key derived from it. */
  secret: string;
  engineUrl: string;
  /** `REIN_GEOBLOCK_OPERATOR_ORGS`, the same list the engine holds. */
  orgs: readonly string[];
  /** Set `Secure` on the cookie (an https public URL). */
  secure: boolean;
  ttlMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  log?: (line: string) => void;
}

export interface OperatorPass {
  /** True when the request carries a valid, unexpired pass. */
  holds(req: IncomingMessage): boolean;
  /** Serve `GET` / `POST /operator`. Call only for that path. */
  handle(req: IncomingMessage, res: ServerResponse): Promise<void>;
}

interface PassPayload {
  op: 'operator-pass';
  /** The org the key belonged to, or `unscoped`. For the audit line only. */
  org: string;
  /** Unix ms. */
  exp: number;
}

function page(note: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Rein -- operator access</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #e8eaed;
    font: 16px/1.6 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 30rem; padding: 2rem 1.25rem; }
  h1 { font-size: 1.3rem; margin: 0 0 1rem; }
  p { margin: 0 0 1rem; color: #b6bcc6; }
  input, button { font: inherit; padding: 0.55rem 0.7rem; border-radius: 6px; border: 1px solid #343a44; }
  input { width: 100%; box-sizing: border-box; background: #14181d; color: #e8eaed; margin-bottom: 0.75rem; }
  button { background: #7ee0b8; color: #0b0d10; border-color: #7ee0b8; cursor: pointer; }
  .note { color: #f5c451; }
</style>
</head>
<body>
<main>
  <h1>Operator access</h1>
  <p>The hosted Rein service is not offered in this region. This page is for the operator's own team.</p>
  ${note ? `<p class="note">${note}</p>` : ''}
  <form method="post" action="${OPERATOR_PATH}" autocomplete="off">
    <input type="password" name="key" placeholder="API key" aria-label="API key" required autofocus>
    <button type="submit">Continue</button>
  </form>
</main>
</body>
</html>
`;
}

function send(res: ServerResponse, status: number, note: string): void {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(page(note));
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams | undefined> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) return undefined;
    chunks.push(chunk as Buffer);
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
}

export function createOperatorPass(options: OperatorPassOptions): OperatorPass {
  const now = options.now ?? Date.now;
  const doFetch = options.fetchImpl ?? fetch;
  const log = options.log ?? ((line: string) => console.log(line));
  const ttl = options.ttlMs ?? DEFAULT_TTL_MS;
  const base = options.engineUrl.replace(/\/+$/, '');
  // Its own key, so a pass can never be read as a session or the reverse.
  const key = createHmac('sha256', options.secret).update('rein operator pass v1').digest();
  let windowStart = 0;
  let attempts = 0;

  function sign(payload: PassPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return `${body}.${createHmac('sha256', key).update(body).digest('base64url')}`;
  }

  function unsign(token: string | undefined): PassPayload | undefined {
    if (!token) return undefined;
    const dot = token.lastIndexOf('.');
    if (dot < 1) return undefined;
    const body = token.slice(0, dot);
    const mac = Buffer.from(token.slice(dot + 1), 'base64url');
    const want = createHmac('sha256', key).update(body).digest();
    if (mac.length !== want.length || !timingSafeEqual(mac, want)) return undefined;
    try {
      return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as PassPayload;
    } catch {
      return undefined;
    }
  }

  /** The org a key may pass for, or undefined. Every failure is the same "no". */
  async function operatorOf(secret: string): Promise<string | undefined> {
    try {
      const res = await doFetch(`${base}/v1/whoami`, { headers: { authorization: `Bearer ${secret}` } });
      if (res.status !== 200) return undefined;
      const who = (await res.json()) as { auth?: unknown; orgId?: unknown; scopes?: unknown };
      if (who.auth !== 'api-key') return undefined;
      if (who.orgId === undefined) {
        return Array.isArray(who.scopes) && who.scopes.includes('admin') ? 'unscoped' : undefined;
      }
      return typeof who.orgId === 'string' && options.orgs.includes(who.orgId) ? who.orgId : undefined;
    } catch {
      return undefined;
    }
  }

  return {
    holds(req) {
      const pass = unsign(readCookie(req, OPERATOR_COOKIE));
      return pass !== undefined && pass.op === 'operator-pass' && typeof pass.exp === 'number' && pass.exp > now();
    },

    async handle(req, res) {
      if (req.method === 'GET' || req.method === 'HEAD') return send(res, GEOBLOCK_STATUS, '');
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'GET, POST' });
        res.end();
        return;
      }
      const at = now();
      if (at - windowStart >= 60_000) {
        windowStart = at;
        attempts = 0;
      }
      attempts += 1;
      if (attempts > MAX_ATTEMPTS_PER_MINUTE) {
        res.setHeader('Retry-After', '60');
        return send(res, 429, 'Too many attempts. Try again in a minute.');
      }
      const form = await readForm(req);
      const secret = form?.get('key')?.trim();
      const org = secret ? await operatorOf(secret) : undefined;
      if (!org) {
        log('[rein] operator pass refused');
        return send(res, GEOBLOCK_STATUS, 'That key was not accepted.');
      }
      const exp = at + ttl;
      log(`[rein] operator pass issued (${org}), valid until ${new Date(exp).toISOString()}`);
      res.writeHead(303, {
        Location: '/',
        'Cache-Control': 'no-store',
        'Set-Cookie': [
          `${OPERATOR_COOKIE}=${encodeURIComponent(sign({ op: 'operator-pass', org, exp }))}`,
          'Path=/',
          `Max-Age=${Math.floor(ttl / 1000)}`,
          'HttpOnly',
          'SameSite=Lax',
          ...(options.secure ? ['Secure'] : []),
        ].join('; '),
      });
      res.end();
    },
  };
}
