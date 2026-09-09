import { generateKeyPairSync } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { newId } from '@reinconsole/core';
import { authFromEnv, buildServer, requiredScope, resolveHost } from './server.js';
import { ApiKeyAuth } from './auth.js';
import { ApprovalService, signApproval } from './approvals.js';
import { PolicyEngine } from './engine.js';

/** A1 (who may call the engine) and A2's HTTP surface (signed approvals). */

describe('engine API auth', () => {
  async function protectedServer() {
    const auth = new ApiKeyAuth();
    const admin = await auth.issue({ name: 'ops', scopes: ['admin'] });
    const runner = await auth.issue({ name: 'fleet', scopes: ['evaluate'] });
    return { app: buildServer(new PolicyEngine(), { auth }), admin, runner };
  }

  it('leaves /health open and advertises that a key is required', async () => {
    const { app } = await protectedServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().auth).toBe('api-key');
    await app.close();
  });

  it('answers 401 with a challenge, never a silent pass', async () => {
    const { app } = await protectedServer();
    const res = await app.inject({ method: 'GET', url: '/v1/decisions' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toContain('Bearer');
    expect(res.json().error).toBe('missing_credentials');
    await app.close();
  });

  it('answers 403 when the key is real but the scope is not', async () => {
    const { app, runner } = await protectedServer();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${runner.secret}` },
      payload: { policyId: 'pol_x', rules: [], default: 'allow' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('insufficient_scope');
    await app.close();
  });

  it('lets a scoped key through on its own route', async () => {
    const { app, admin, runner } = await protectedServer();
    await app.inject({
      method: 'POST',
      url: '/v1/policies',
      headers: { authorization: `Bearer ${admin.secret}` },
      payload: { policyId: 'pol_open', rules: [], default: 'allow' },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: { authorization: `Bearer ${runner.secret}` },
      payload: {
        agentId: newId('agt'),
        vendor: { host: 'api.example.com', address: '0x1' },
        resource: '/v1/answer',
        amount: '1.00',
        asset: 'USDC',
        chain: 'base',
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().decision.outcome).toBe('allow');
    await app.close();
  });

  it('issues and rotates keys over the API', async () => {
    const { app, admin } = await protectedServer();
    const headers = { authorization: `Bearer ${admin.secret}` };

    const issued = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers,
      payload: { name: 'reader', scopes: ['read'] },
    });
    expect(issued.statusCode).toBe(201);
    const { key, secret } = issued.json();
    expect(secret).toMatch(/^rk_/);

    const readOk = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(readOk.statusCode).toBe(200);

    const rotated = await app.inject({
      method: 'POST',
      url: `/v1/keys/${key.id}/rotate`,
      headers,
      payload: { graceMs: 0 },
    });
    expect(rotated.statusCode).toBe(200);
    expect(rotated.json().secret).not.toBe(secret);

    const stale = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { authorization: `Bearer ${secret}` },
    });
    expect(stale.statusCode).toBe(401);

    // A listed key never carries its digest, let alone its secret.
    const listed = await app.inject({ method: 'GET', url: '/v1/keys', headers });
    expect(listed.payload).not.toContain('secretHash');
    await app.close();
  });

  it('demands admin for any route nobody classified', () => {
    expect(requiredScope('GET', '/v1/decisions')).toBe('read');
    expect(requiredScope('POST', '/v1/evaluate')).toBe('evaluate');
    // Reporting a settlement rides the spender's scope: the guard that paid is
    // the component that sees the vendor confirm it, and a settlement report
    // can only close a reconciliation gap — it authorizes nothing.
    expect(requiredScope('POST', '/v1/settlements')).toBe('evaluate');
    expect(requiredScope('GET', '/v1/reconciliation')).toBe('read');
    // A heartbeat rides the spender's scope too, and for a stronger reason:
    // every intent is already a sighting, so a key that can evaluate can
    // already make an agent look alive by simply spending.
    expect(requiredScope('POST', '/v1/agents/agt_1/heartbeat')).toBe('evaluate');
    // Declaring the expectation is configuration, and stays admin.
    expect(requiredScope('PUT', '/v1/agents/agt_1/liveness')).toBe('admin');
    expect(requiredScope('DELETE', '/v1/agents/agt_1/liveness')).toBe('admin');
    expect(requiredScope('GET', '/v1/liveness')).toBe('read');
    expect(requiredScope('POST', '/v1/approvals/dec_1/resolve')).toBe('approve');
    expect(requiredScope('POST', '/v1/policies')).toBe('admin');
    expect(requiredScope('POST', '/v1/something-invented-next-year')).toBe('admin');
    expect(requiredScope('DELETE', '/v1/agents/agt_1')).toBe('admin');
  });
});

describe('standalone boot posture', () => {
  it('binds loopback rather than exposing an unauthenticated engine', () => {
    const { host, warning } = resolveHost({}, false);
    expect(host).toBe('127.0.0.1');
    expect(warning).toContain('REIN_ENGINE_API_KEY');
  });

  it('refuses a public bind with no key, and names both remedies', () => {
    expect(() => resolveHost({ HOST: '0.0.0.0' }, false)).toThrow(/refusing to bind/);
    try {
      resolveHost({ HOST: '0.0.0.0' }, false);
    } catch (err) {
      expect(String(err)).toContain('REIN_ENGINE_API_KEY');
      expect(String(err)).toContain('REIN_ENGINE_AUTH=off');
    }
  });

  it('binds anywhere once a key exists, or when opted out deliberately', () => {
    expect(resolveHost({ HOST: '0.0.0.0' }, true).host).toBe('0.0.0.0');
    const optedOut = resolveHost({ HOST: '0.0.0.0', REIN_ENGINE_AUTH: 'off' }, false);
    expect(optedOut.host).toBe('0.0.0.0');
    expect(optedOut.warning).toContain('unauthenticated');
  });

  it('seeds admin keys from the environment', async () => {
    expect(await authFromEnv({})).toBeUndefined();
    const auth = await authFromEnv({ REIN_ENGINE_API_KEY: 'rk_one, rk_two' });
    expect(auth?.list()).toHaveLength(2);
    expect(auth?.authenticate({ authorization: 'Bearer rk_two' }, 'admin')).toBeDefined();
  });
});

describe('approval routes', () => {
  async function escalatingServer() {
    const approvals = new ApprovalService();
    const engine = new PolicyEngine({ approvals });
    await engine.addPolicy({
      policyId: 'pol_review',
      rules: [{ id: 'big-ticket', escalate: { amountGt: '10.00' } }],
      default: 'allow',
    });
    const app = buildServer(engine);
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');

    const approverRes = await app.inject({
      method: 'POST',
      url: '/v1/approvers',
      payload: {
        orgId: newId('org'),
        name: 'Finance',
        publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      },
    });
    expect(approverRes.statusCode).toBe(201);
    return { app, approver: approverRes.json(), privateKey };
  }

  async function escalate(app: ReturnType<typeof buildServer>) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      payload: {
        agentId: newId('agt'),
        vendor: { host: 'api.example.com', address: '0x1' },
        resource: '/v1/answer',
        amount: '50.00',
        asset: 'USDC',
        chain: 'base',
      },
    });
    return res.json();
  }

  it('walks the full loop: escalate, read the challenge, sign, resolve', async () => {
    const { app, approver, privateKey } = await escalatingServer();
    const { decision, approval } = await escalate(app);
    expect(decision.outcome).toBe('escalate');
    expect(approval.status).toBe('pending');

    const view = await app.inject({ method: 'GET', url: `/v1/approvals/${decision.id}` });
    expect(view.statusCode).toBe(200);
    const { challenges } = view.json();
    expect(challenges.approve).toContain('"verdict":"approve"');

    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${decision.id}/resolve`,
      payload: {
        intentHash: decision.intentHash,
        verdict: 'approve',
        approverKeyId: approver.id,
        signature: signApproval(privateKey, {
          decisionId: decision.id,
          intentHash: decision.intentHash,
          verdict: 'approve',
        }),
      },
    });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().decision.outcome).toBe('allow');

    // The resolved view now hands back the follow-up decision — the voucher.
    const after = await app.inject({ method: 'GET', url: `/v1/approvals/${decision.id}` });
    expect(after.json().request.status).toBe('approved');
    expect(after.json().decision.outcome).toBe('allow');
    await app.close();
  });

  it('rejects a forged signature with a 400 and leaves the request pending', async () => {
    const { app, approver } = await escalatingServer();
    const { decision } = await escalate(app);

    const res = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${decision.id}/resolve`,
      payload: {
        intentHash: decision.intentHash,
        verdict: 'approve',
        approverKeyId: approver.id,
        signature: Buffer.from('not a real signature').toString('base64'),
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('bad_signature');

    const view = await app.inject({ method: 'GET', url: `/v1/approvals/${decision.id}` });
    expect(view.json().request.status).toBe('pending');
    await app.close();
  });

  it('lists what is still answerable and 404s an unknown escalation', async () => {
    const { app } = await escalatingServer();
    const { decision } = await escalate(app);

    const pending = await app.inject({ method: 'GET', url: '/v1/approvals' });
    expect(pending.json().map((r: { decisionId: string }) => r.decisionId)).toEqual([decision.id]);

    const missing = await app.inject({ method: 'GET', url: `/v1/approvals/${newId('dec')}` });
    expect(missing.statusCode).toBe(404);
    await app.close();
  });

  it('404s the approval surface on an engine without the tier', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/approvals' });
    expect(res.statusCode).toBe(404);
    expect(res.json().message).toContain('no approval service');
    await app.close();
  });
});
