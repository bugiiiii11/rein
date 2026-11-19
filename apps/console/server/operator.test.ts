/**
 * The operator pass over a real socket, behind the real geo gate. The engine
 * is a stub `fetch` that answers `/v1/whoami` from a key table.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_GEOBLOCK_TERRITORIES, GeoBlock } from '@reinconsole/policy-engine';
import { createGeoGate } from './geo';
import { createOperatorPass, OPERATOR_COOKIE } from './operator';

const GB = '25.0.0.1';
const KP = '175.45.176.1';
const OPERATOR_ORG = 'org_operator';
const SECRET = 'a-session-secret-of-at-least-32-characters';

const KEYS: Record<string, { orgId?: string; scopes: string[] }> = {
  rk_operator: { orgId: OPERATOR_ORG, scopes: ['admin'] },
  rk_stranger: { orgId: 'org_stranger', scopes: ['admin'] },
  rk_root: { scopes: ['admin'] },
  rk_console_read: { scopes: ['read'] },
};

const whoami = (async (url: string | URL | Request, init?: RequestInit) => {
  expect(String(url)).toBe('https://engine.test/v1/whoami');
  const bearer = String((init?.headers as Record<string, string>)['authorization']).replace('Bearer ', '');
  const key = KEYS[bearer];
  if (!key) return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 });
  return new Response(JSON.stringify({ auth: 'api-key', keyId: 'key_1', name: 'k', ...key }), { status: 200 });
}) as typeof fetch;

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

async function boot(options: { now?: () => number; fetchImpl?: typeof fetch } = {}) {
  const lines: string[] = [];
  const pass = createOperatorPass({
    secret: SECRET,
    engineUrl: 'https://engine.test/',
    orgs: [OPERATOR_ORG],
    secure: true,
    fetchImpl: options.fetchImpl ?? whoami,
    log: (line) => lines.push(line),
    ...(options.now ? { now: options.now } : {}),
  });
  const refuse = createGeoGate(new GeoBlock([...DEFAULT_GEOBLOCK_TERRITORIES, 'GB']), pass);
  server = createServer((req, res) => {
    if (refuse(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('next');
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return { port: (server.address() as AddressInfo).port, lines };
}

function call(
  port: number,
  method: string,
  path: string,
  from: string | undefined,
  options: { body?: string; cookie?: string } = {},
): Promise<{ status: number; body: string; setCookie: string; location: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: '127.0.0.1',
        port,
        path,
        method,
        headers: {
          ...(from ? { 'X-Forwarded-For': from } : {}),
          ...(options.cookie ? { Cookie: options.cookie } : {}),
          ...(options.body !== undefined ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
        },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            setCookie: String(res.headers['set-cookie']?.[0] ?? ''),
            location: String(res.headers.location ?? ''),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(options.body);
  });
}

/** `name=value` out of a Set-Cookie line. */
const pair = (setCookie: string) => setCookie.split(';')[0]!;

describe('the operator pass', () => {
  it('serves the form from a not-offered territory, still as a 451', async () => {
    const { port } = await boot();
    const res = await call(port, 'GET', '/operator', GB);
    expect(res.status).toBe(451);
    expect(res.body).toContain('name="key"');
    expect(res.body).not.toMatch(/<script|<link|src=/);
  });

  it('gives a listed org a cookie that opens the console, and logs the org, not the key', async () => {
    const { port, lines } = await boot();
    expect((await call(port, 'GET', '/', GB)).status).toBe(451);
    const res = await call(port, 'POST', '/operator', GB, { body: 'key=rk_operator' });
    expect(res.status).toBe(303);
    expect(res.location).toBe('/');
    expect(res.setCookie).toMatch(new RegExp(`^${OPERATOR_COOKIE}=`));
    expect(res.setCookie).toContain('HttpOnly');
    expect(res.setCookie).toContain('Secure');
    expect(res.setCookie).toContain('SameSite=Lax');
    expect((await call(port, 'GET', '/', GB, { cookie: pair(res.setCookie) })).status).toBe(200);
    expect((await call(port, 'GET', '/api/state', GB, { cookie: pair(res.setCookie) })).status).toBe(200);
    expect(lines.join('\n')).toContain(`operator pass issued (${OPERATOR_ORG})`);
    expect(lines.join('\n')).not.toContain('rk_operator');
  });

  it('accepts an unscoped admin key', async () => {
    const { port } = await boot();
    expect((await call(port, 'POST', '/operator', GB, { body: 'key=rk_root' })).status).toBe(303);
  });

  it('refuses every other key the same way, with no cookie', async () => {
    const { port } = await boot();
    for (const key of ['rk_stranger', 'rk_console_read', 'rk_nobody', '']) {
      const res = await call(port, 'POST', '/operator', GB, { body: `key=${key}` });
      expect(res.status, key).toBe(451);
      expect(res.setCookie, key).toBe('');
      expect(res.body, key).toContain('That key was not accepted.');
    }
  });

  it('refuses when the engine does not answer', async () => {
    const down = (async () => {
      throw new Error('ECONNREFUSED');
    }) as typeof fetch;
    const { port } = await boot({ fetchImpl: down });
    expect((await call(port, 'POST', '/operator', GB, { body: 'key=rk_operator' })).status).toBe(451);
  });

  it('never opens a sanctioned territory: no form, and a valid pass does nothing', async () => {
    const { port } = await boot();
    const issued = await call(port, 'POST', '/operator', GB, { body: 'key=rk_operator' });
    const form = await call(port, 'GET', '/operator', KP);
    expect(form.status).toBe(451);
    expect(form.body).not.toContain('name="key"');
    expect((await call(port, 'POST', '/operator', KP, { body: 'key=rk_operator' })).setCookie).toBe('');
    expect((await call(port, 'GET', '/', KP, { cookie: pair(issued.setCookie) })).status).toBe(451);
  });

  it('rejects a forged, altered or expired pass', async () => {
    let at = Date.UTC(2026, 10, 19);
    const { port } = await boot({ now: () => at });
    const issued = pair((await call(port, 'POST', '/operator', GB, { body: 'key=rk_operator' })).setCookie);
    const forged = `${OPERATOR_COOKIE}=${Buffer.from(JSON.stringify({ op: 'operator-pass', org: 'x', exp: at * 2 })).toString('base64url')}.AAAA`;
    expect((await call(port, 'GET', '/', GB, { cookie: forged })).status).toBe(451);
    expect((await call(port, 'GET', '/', GB, { cookie: `${issued}x` })).status).toBe(451);
    expect((await call(port, 'GET', '/', GB, { cookie: issued })).status).toBe(200);
    at += 31 * 24 * 60 * 60 * 1000;
    expect((await call(port, 'GET', '/', GB, { cookie: issued })).status).toBe(451);
  });

  it('limits attempts across everybody', async () => {
    const { port } = await boot();
    for (let i = 0; i < 5; i += 1) {
      expect((await call(port, 'POST', '/operator', GB, { body: 'key=rk_nobody' })).status).toBe(451);
    }
    const res = await call(port, 'POST', '/operator', GB, { body: 'key=rk_operator' });
    expect(res.status).toBe(429);
    expect(res.setCookie).toBe('');
  });

  it('leaves everyone outside the refused territories alone', async () => {
    const { port } = await boot();
    expect((await call(port, 'GET', '/operator', '8.8.8.8')).body).toBe('next');
  });
});
