import { describe, it, expect } from 'vitest';
import { newId } from '@rein/core';
import { ReputationGraph } from './graph.js';
import { buildGraphServer } from './server.js';

const NOW = new Date('2026-06-11T12:00:00Z');
const DAY = 86_400_000;

/** A JSON-safe gate.settled event (what a remote gate would POST). */
function gateSettledJson(over: { payer?: string; at?: string } = {}) {
  const at = over.at ?? NOW.toISOString();
  return {
    type: 'gate.settled',
    at,
    receipt: {
      id: newId('grc'),
      at,
      route: '/api/*',
      resource: '/api/answer',
      method: 'GET',
      payer: over.payer ?? '0xPayer01',
      payTo: '0xTreasury',
      amount: '0.05',
      amountAtomic: '50000',
      asset: 'USDC',
      network: 'base',
      transaction: '0xtx',
    },
  };
}

describe('graph HTTP API', () => {
  it('reports health with the subject count', async () => {
    const app = buildGraphServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', subjects: 0 });
  });

  it('ingests a single event or a batch on /v1/events', async () => {
    const graph = new ReputationGraph();
    const app = buildGraphServer(graph);
    const one = await app.inject({ method: 'POST', url: '/v1/events', payload: gateSettledJson() });
    expect(one.json()).toEqual({ ingested: 1 });
    const batch = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: [gateSettledJson({ payer: '0xPayer02' }), gateSettledJson({ payer: '0xPayer03' })],
    });
    expect(batch.json()).toEqual({ ingested: 2 });
    expect(graph.subjects()).toBe(4); // 3 payers + the shared treasury
  });

  it('rejects malformed events with a clean 400', async () => {
    const app = buildGraphServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events',
      payload: { type: 'gate.settled', at: 'not-a-date' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
  });

  it('serves scores, filterable by kind', async () => {
    const graph = new ReputationGraph();
    graph.ingest({
      type: 'gate.settled',
      at: NOW,
      receipt: gateSettledJson().receipt as never,
    });
    const app = buildGraphServer(graph);
    const all = await app.inject({ method: 'GET', url: '/v1/scores' });
    expect(all.json()).toHaveLength(2);
    const vendors = await app.inject({ method: 'GET', url: '/v1/scores?kind=vendor' });
    expect(vendors.json()).toHaveLength(1);
    expect(vendors.json()[0].subject).toEqual({ kind: 'vendor', id: '0xtreasury' });
    expect(vendors.json()[0].components).toBeDefined();
  });

  it('explains one subject with its evidence, and 404s the unknown', async () => {
    const graph = new ReputationGraph();
    graph.ingest({ type: 'gate.settled', at: NOW, receipt: gateSettledJson().receipt as never });
    const app = buildGraphServer(graph);
    const found = await app.inject({ method: 'GET', url: '/v1/scores/agent/0xPayer01' });
    expect(found.statusCode).toBe(200);
    expect(found.json().evidence).toMatchObject({ attempts: 1, settled: 1, volume: '0.05' });
    const missing = await app.inject({ method: 'GET', url: '/v1/scores/vendor/never.test' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json().error).toBe('not_found');
  });

  it('accepts manual reports and returns the updated score', async () => {
    const graph = new ReputationGraph();
    graph.ingest({
      type: 'gate.settled',
      at: new Date(NOW.getTime() - 14 * DAY),
      receipt: gateSettledJson({ at: new Date(NOW.getTime() - 14 * DAY).toISOString() })
        .receipt as never,
    });
    const before = graph.score({ kind: 'vendor', id: '0xTreasury' })!.score;
    const app = buildGraphServer(graph);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/reports',
      payload: { subject: { kind: 'vendor', id: '0xTreasury' }, kind: 'dispute' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().score).toBeLessThan(before);
  });
});
