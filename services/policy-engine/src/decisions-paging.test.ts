import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { Decision, newId } from '@reinconsole/core';
import { buildServer } from './server.js';
import { PolicyEngine } from './engine.js';
import { verifyDecisionChain } from './decision-log.js';
import type { FastifyInstance } from 'fastify';

/**
 * A3's bounded-read half: `GET /v1/decisions` is a page, not the whole log.
 *
 * The property that matters is not "it returns fewer rows" — it is that what
 * it returns is still a CHAIN. An audit surface that pages by handing out an
 * unverifiable subset has given up the one thing the decision log is for.
 */

async function engineWith(decisions: number): Promise<FastifyInstance> {
  const app = buildServer(new PolicyEngine());
  await app.inject({
    method: 'POST',
    url: '/v1/policies',
    payload: { policyId: 'pol_open', default: 'allow' },
  });
  const agentId = newId('agt');
  for (let i = 0; i < decisions; i += 1) {
    await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      payload: {
        agentId,
        vendor: { host: 'api.example.com', address: '0x1' },
        resource: `/v1/answer/${i}`,
        amount: '0.01',
        asset: 'USDC',
        chain: 'base',
      },
    });
  }
  return app;
}

/**
 * Parsed through the schema, the way `EngineClient` does — `decidedAt` is an
 * ISO string on the wire and a Date in `canonicalDecision`, so a test that
 * skipped the parse would verify a chain no real client ever sees.
 */
const page = (res: { json: () => unknown }): Decision[] => z.array(Decision).parse(res.json());

/** The key the chain is signed under, read the way any client reads it. */
async function publicKeyOf(app: FastifyInstance): Promise<string> {
  const res = await app.inject({ method: 'GET', url: '/health' });
  return (res.json() as { publicKey: string }).publicKey;
}

describe('GET /v1/decisions paging', () => {
  it('the body stays a bare array, so a 0.2.0 client parses it unchanged', async () => {
    const app = await engineWith(3);
    const res = await app.inject({ method: 'GET', url: '/v1/decisions' });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json())).toBe(true);
    expect(page(res)).toHaveLength(3);
    await app.close();
  });

  it('reports the chain length, and says nothing about a next page at the head', async () => {
    const app = await engineWith(3);
    const res = await app.inject({ method: 'GET', url: '/v1/decisions' });
    expect(res.headers['rein-chain-length']).toBe('3');
    // Absence is the signal. An empty page would be indistinguishable from
    // "caught up" for a client polling a live engine.
    expect(res.headers['rein-next-after']).toBeUndefined();
    await app.close();
  });

  it('walks the whole chain a page at a time, and the concatenation verifies', async () => {
    const app = await engineWith(7);
    const collected: Decision[] = [];
    let after: number | undefined;
    let pages = 0;
    for (;;) {
      const url = `/v1/decisions?limit=2${after === undefined ? '' : `&after=${after}`}`;
      const res = await app.inject({ method: 'GET', url });
      collected.push(...page(res));
      pages += 1;
      const next = res.headers['rein-next-after'];
      if (next === undefined) break;
      after = Number(next);
      expect(pages).toBeLessThan(10); // a cursor that never advances is a hang
    }
    expect(pages).toBe(4); // 2 + 2 + 2 + 1
    expect(collected).toHaveLength(7);
    // The whole point: paging did not cost the audit its verifiability.
    expect(verifyDecisionChain(collected, await publicKeyOf(app))).toBe(true);
    await app.close();
  });

  it('the FIRST page alone is a valid verifying prefix', async () => {
    // Which is why the default truncates from the OLDEST end rather than
    // returning the newest 500: a suffix of the chain cannot be verified
    // without the decisions before it.
    const app = await engineWith(5);
    const res = await app.inject({ method: 'GET', url: '/v1/decisions?limit=3' });
    const first = page(res);
    expect(first).toHaveLength(3);
    expect(verifyDecisionChain(first, await publicKeyOf(app))).toBe(true);
    await app.close();
  });

  it('`after` is exclusive — the page starts at the decision AFTER the one you hold', async () => {
    const app = await engineWith(4);
    const all = page(await app.inject({ method: 'GET', url: '/v1/decisions' }));
    const rest = page(await app.inject({ method: 'GET', url: '/v1/decisions?after=1' }));
    expect(rest.map((d) => d.id)).toEqual(all.slice(2).map((d) => d.id));
    await app.close();
  });

  it('an `after` past the head is an empty page, not an error', async () => {
    // A client that polls a live engine sits in exactly this state whenever
    // nothing has happened since its last read.
    const app = await engineWith(2);
    const res = await app.inject({ method: 'GET', url: '/v1/decisions?after=99' });
    expect(res.statusCode).toBe(200);
    expect(page(res)).toEqual([]);
    expect(res.headers['rein-next-after']).toBeUndefined();
    expect(res.headers['rein-chain-length']).toBe('2');
    await app.close();
  });

  it('refuses a limit past the ceiling rather than quietly capping it', async () => {
    const app = await engineWith(1);
    const res = await app.inject({ method: 'GET', url: '/v1/decisions?limit=5000' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    await app.close();
  });

  it('refuses a negative cursor', async () => {
    const app = await engineWith(1);
    const res = await app.inject({ method: 'GET', url: '/v1/decisions?after=-1' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
