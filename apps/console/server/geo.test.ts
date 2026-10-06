/**
 * The console's geo gate (S98) over a real socket. The test client connects
 * from loopback, which is exactly where Railway's edge reaches the console
 * from, so `X-Forwarded-For` here plays the edge's appended address -- and
 * the left-hand entries play whatever a client wrote itself.
 */
import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { GEOBLOCK_BODY, GeoBlock } from '@reinconsole/policy-engine';
import { createGeoGate } from './geo';

const KP = '175.45.176.1';
const ELSEWHERE = '8.8.8.8';

let server: Server | undefined;
afterEach(async () => {
  await new Promise<void>((done) => (server ? server.close(() => done()) : done()));
  server = undefined;
});

/** A console whose every un-refused request answers 200 `next`. */
async function boot(geoBlock: GeoBlock | undefined): Promise<number> {
  const refuse = createGeoGate(geoBlock);
  server = createServer((req, res) => {
    if (refuse(req, res)) return;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('next');
  });
  await new Promise<void>((done) => server!.listen(0, '127.0.0.1', done));
  return (server.address() as AddressInfo).port;
}

/** node:http rather than fetch, so the forwarding header goes out exactly as written. */
function get(
  port: number,
  path: string,
  forwardedFor?: string,
): Promise<{ status: number; type: string; cache: string; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: '127.0.0.1', port, path, headers: forwardedFor ? { 'X-Forwarded-For': forwardedFor } : {} },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk: string) => (body += chunk));
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            type: String(res.headers['content-type'] ?? ''),
            cache: String(res.headers['cache-control'] ?? ''),
            body,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('the console geo gate', () => {
  it('answers an API call from a refused territory with the engine 451 as JSON', async () => {
    const port = await boot(new GeoBlock());
    const res = await get(port, '/api/state', KP);
    expect(res.status).toBe(451);
    expect(res.type).toBe('application/json');
    expect(res.cache).toBe('no-store');
    expect(JSON.parse(res.body)).toEqual(GEOBLOCK_BODY);
  });

  it('answers a page, the claim page included, as plain text', async () => {
    const port = await boot(new GeoBlock());
    for (const path of ['/', '/claim', '/assets/index.js']) {
      const res = await get(port, path, KP);
      expect(res.status, path).toBe(451);
      expect(res.type, path).toBe('text/plain; charset=utf-8');
      expect(res.body, path).toBe(`${GEOBLOCK_BODY.message}\n`);
    }
  });

  it('passes everyone else through, including a direct connection with no header', async () => {
    const port = await boot(new GeoBlock());
    expect((await get(port, '/api/state', ELSEWHERE)).status).toBe(200);
    expect((await get(port, '/claim')).status).toBe(200);
  });

  it('judges the address the edge appended, not one the client wrote', async () => {
    const port = await boot(new GeoBlock());
    // A client in KP that forges an outside address: the edge appends KP last.
    expect((await get(port, '/api/state', `${ELSEWHERE}, ${KP}`)).status).toBe(451);
    // A client elsewhere whose own header names KP is not refused for it.
    expect((await get(port, '/api/state', `${KP}, ${ELSEWHERE}`)).status).toBe(200);
  });

  it('refuses nobody when the block is off', async () => {
    const port = await boot(undefined);
    expect((await get(port, '/api/state', KP)).status).toBe(200);
  });
});
