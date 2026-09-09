import { describe, it, expect } from 'vitest';
import { newId } from '@reinconsole/core';
import { buildServer } from './server.js';

describe('policy-engine HTTP API', () => {
  it('serves health with the decision-log public key', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.publicKey).toContain('BEGIN PUBLIC KEY');
    await app.close();
  });

  it('reconciles over HTTP: an allowance opens a gap and a settlement closes it', async () => {
    const app = buildServer();
    const agentId = newId('agt');
    await app.inject({
      method: 'POST',
      url: '/v1/policies',
      payload: { policyId: 'pol_open', default: 'allow' },
    });
    const evaluated = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      payload: {
        agentId,
        vendor: { host: 'api.example.com', address: '0x1' },
        resource: '/v1/answer',
        amount: '1.00',
        asset: 'USDC',
        chain: 'base',
      },
    });
    const intentId = evaluated.json().intent.id;

    const open = await app.inject({ method: 'GET', url: '/v1/reconciliation?graceMs=0' });
    expect(open.statusCode).toBe(200);
    expect(open.json()).toMatchObject({ allowed: 1, unsettled: 1, settlementsSeen: 0 });

    // 202, not 200: the engine is ACCEPTING a claim about the world, not
    // deciding anything — the only thing this can change is a report.
    const reported = await app.inject({
      method: 'POST',
      url: '/v1/settlements',
      payload: { intentId, txHash: '0xabc', source: 'indexer', confirmedAt: new Date() },
    });
    expect(reported.statusCode).toBe(202);

    const closed = await app.inject({ method: 'GET', url: '/v1/reconciliation?graceMs=0' });
    expect(closed.json()).toMatchObject({ settled: 1, unsettled: 0, settlementsSeen: 1 });
    await app.close();
  });

  it('rejects a settlement report for something that is not an intent id', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/settlements',
      payload: { intentId: 'nope', confirmedAt: new Date() },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    await app.close();
  });

  it('serves breaker standing on a read-scope route', async () => {
    const app = buildServer();
    const agentId = newId('agt');
    await app.inject({
      method: 'POST',
      url: '/v1/policies',
      payload: {
        policyId: 'pol_breaker',
        breakers: [{ id: 'velocity', window: '1h', txCount: 1 }],
        default: 'allow',
      },
    });
    const intent = {
      agentId,
      vendor: { host: 'api.example.com', address: '0x1' },
      resource: '/v1/answer',
      amount: '1.00',
      asset: 'USDC',
      chain: 'base',
    };
    await app.inject({ method: 'POST', url: '/v1/evaluate', payload: intent });

    const res = await app.inject({ method: 'GET', url: `/v1/agents/${agentId}/breakers` });
    expect(res.statusCode).toBe(200);
    const [state] = res.json();
    expect(state.breaker.id).toBe('velocity');
    expect(state.txCount).toBe(1);
    // One transaction inside a 1-tx envelope: the NEXT one would exceed it.
    expect(state.tripped).toBe(true);
    expect(state.reason).toMatch(/2 tx > 1 in 1h/);
    await app.close();
  });

  it('registers an agent, adds a policy, and evaluates an intent end-to-end', async () => {
    const app = buildServer();

    const agentRes = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      payload: { orgId: newId('org'), name: 'Research Agent' },
    });
    expect(agentRes.statusCode).toBe(200);
    const agent = agentRes.json();
    expect(agent.id).toMatch(/^agt_/);

    const policyRes = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      payload: {
        policyId: 'pol_cap',
        rules: [{ id: 'hard-cap', deny: { amountGt: '5.00' } }],
        default: 'allow',
      },
    });
    expect(policyRes.statusCode).toBe(200);

    const evalRes = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      payload: {
        agentId: agent.id,
        vendor: { host: 'api.example.com', address: '0x1' },
        resource: '/v1/answer',
        amount: '6.00',
        asset: 'USDC',
        chain: 'base',
      },
    });
    expect(evalRes.statusCode).toBe(200);
    const { decision, intent } = evalRes.json();
    expect(decision.outcome).toBe('deny');
    expect(decision.matchedRules).toContain('hard-cap');
    expect(intent.id).toMatch(/^int_/);

    await app.close();
  });

  it('returns a 400 on an invalid intent', async () => {
    const app = buildServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      payload: { agentId: 'not-an-agent-id', amount: '1', asset: 'USDC', chain: 'base' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('validation_error');
    await app.close();
  });
});
