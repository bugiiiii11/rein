/**
 * D1(a): who may write to the reputation graph.
 *
 * The asymmetry this file pins: READS stay open, because a score nobody can
 * read governs nothing, while a WRITE is evidence about a subject that did not
 * send it. Before this, `POST /v1/events` accepted reputation evidence from
 * anyone who could reach the port, and the only thing standing between that and
 * the internet was a loopback default.
 */
import { describe, it, expect } from 'vitest';
import { newId } from '@reinconsole/core';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { ReputationGraph } from './graph.js';
import { buildGraphServer, graphAuthFromEnv, resolveGraphHost } from './server.js';

const NOW = new Date('2026-06-11T12:00:00Z').toISOString();

function gateSettledJson() {
  return {
    type: 'gate.settled',
    at: NOW,
    receipt: {
      id: newId('grc'),
      at: NOW,
      route: '/api/*',
      resource: '/api/answer',
      method: 'GET',
      payer: '0xPayer01',
      payTo: '0xTreasury',
      amount: '0.05',
      amountAtomic: '50000',
      asset: 'USDC',
      network: 'base',
      transaction: '0xtx',
    },
  };
}

/** A server whose writes demand `report`, plus the secret that holds it. */
async function guardedGraph(scopes: Parameters<ApiKeyAuth['issue']>[0]['scopes'] = ['report']) {
  const auth = new ApiKeyAuth();
  const { secret } = await auth.issue({ name: 'indexer', scopes });
  const graph = new ReputationGraph();
  return { app: buildGraphServer(graph, { auth }), graph, secret };
}

describe('graph write auth (D1a)', () => {
  it('advertises the posture on /health, so a producer never has to guess', async () => {
    const { app } = await guardedGraph();
    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      status: 'ok',
      auth: 'api-key',
    });
    const open = buildGraphServer();
    expect((await open.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      auth: 'none',
    });
  });

  it('refuses every write route without a credential, with a challenge', async () => {
    const { app, graph } = await guardedGraph();
    for (const url of ['/v1/events', '/v1/reports', '/v1/links']) {
      const res = await app.inject({ method: 'POST', url, payload: gateSettledJson() });
      expect(res.statusCode, url).toBe(401);
      expect(res.json().error, url).toBe('missing_credentials');
      // A challenge, never a silent 404: a producer holding no key should
      // learn that, not conclude the route moved.
      expect(res.headers['www-authenticate'], url).toBe('Bearer realm="rein-graph"');
    }
    // Nothing was ingested on the way to the refusal.
    expect(graph.subjects()).toBe(0);
  });

  it('accepts the report key and lands the evidence', async () => {
    const { app, graph, secret } = await guardedGraph();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${secret}` },
      payload: gateSettledJson(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ingested: 1 });
    expect(graph.subjects()).toBeGreaterThan(0);
  });

  it('accepts X-Api-Key too, because a fair share of runtimes send only that', async () => {
    const { app, secret } = await guardedGraph();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { 'x-api-key': secret },
      payload: gateSettledJson(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('refuses a key that may spend but not report — the scope is not decorative', async () => {
    const { app, graph, secret } = await guardedGraph(['evaluate']);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${secret}` },
      payload: gateSettledJson(),
    });
    // The point of a separate scope: a fleet key that governs its OWN budget
    // has no business moving a vendor's score.
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('insufficient_scope');
    expect(graph.subjects()).toBe(0);
  });

  it('lets an admin key through, because admin satisfies every scope', async () => {
    const { app, secret } = await guardedGraph(['admin']);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${secret}` },
      payload: gateSettledJson(),
    });
    expect(res.statusCode).toBe(200);
  });

  it('leaves reads open — the showcase is the product', async () => {
    const { app, secret } = await guardedGraph();
    await app.inject({
      method: 'POST',
      url: '/v1/events',
      headers: { authorization: `Bearer ${secret}` },
      payload: gateSettledJson(),
    });
    for (const url of ['/health', '/v1/scores', '/v1/scores?kind=vendor']) {
      expect((await app.inject({ method: 'GET', url })).statusCode, url).toBe(200);
    }
    // Including the 404 path: an unknown subject still answers without a key.
    expect(
      (await app.inject({ method: 'GET', url: '/v1/scores/vendor/never.test' })).statusCode,
    ).toBe(404);
  });

  it('answers an unknown WRITE path with 401, not 404 — routes are not a map', async () => {
    const { app } = await guardedGraph();
    const res = await app.inject({ method: 'POST', url: '/v1/nope', payload: {} });
    expect(res.statusCode).toBe(401);
  });
});

describe('graphAuthFromEnv', () => {
  it('is undefined with nothing set, so embedded use needs no ceremony', async () => {
    expect(await graphAuthFromEnv({})).toBeUndefined();
    expect(await graphAuthFromEnv({ REIN_GRAPH_API_KEY: '   ' })).toBeUndefined();
  });

  it('seeds comma-separated secrets, each holding report and nothing more', async () => {
    const auth = await graphAuthFromEnv({ REIN_GRAPH_API_KEY: 'rk_one, rk_two ' });
    expect(auth?.list()).toHaveLength(2);
    expect(auth?.authenticate({ authorization: 'Bearer rk_two' }, 'report').name).toBe('env-key-2');
    // Seeded narrow on purpose: the graph has no key-issuing route to bootstrap,
    // so an admin secret here would grant authority no route needs.
    expect(() => auth?.authenticate({ authorization: 'Bearer rk_one' }, 'admin')).toThrow(
      /insufficient_scope|scope/,
    );
  });
});

describe('resolveGraphHost', () => {
  it('binds loopback by default, leaving the quickstart untouched', () => {
    expect(resolveGraphHost({})).toEqual({ host: '127.0.0.1' });
    expect(resolveGraphHost({ HOST: 'localhost' })).toEqual({ host: 'localhost' });
  });

  it('trades a public bind for a key, the way the engine does', () => {
    expect(resolveGraphHost({}, true)).toEqual({ host: '0.0.0.0' });
    expect(resolveGraphHost({ HOST: '0.0.0.0' }, true)).toEqual({ host: '0.0.0.0' });
  });

  it('refuses a public bind with no key, and names both remedies', () => {
    expect(() => resolveGraphHost({ HOST: '0.0.0.0' })).toThrow(/REIN_GRAPH_API_KEY/);
    expect(() => resolveGraphHost({ HOST: '0.0.0.0' })).toThrow(/REIN_GRAPH_PUBLIC=1/);
  });

  it('still honours the deliberate open graph, with a warning naming what is open', () => {
    const resolved = resolveGraphHost({ HOST: '0.0.0.0', REIN_GRAPH_PUBLIC: '1' });
    expect(resolved.host).toBe('0.0.0.0');
    expect(resolved.warning).toMatch(/unauthenticated/);
    // The literal string, so a stray `true` never reads as consent.
    expect(() => resolveGraphHost({ HOST: '0.0.0.0', REIN_GRAPH_PUBLIC: 'true' })).toThrow();
  });
});
