import { describe, it, expect } from 'vitest';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { buildServer, registeredRoutes, tenantRoute } from './server.js';
import { PolicyEngine } from './engine.js';
import { DEFAULT_SANDBOX_TTL_MS, type SandboxOptions } from './sandbox.js';

const WALLET = '0x1111111111111111111111111111111111111111';

function world(sandbox: SandboxOptions = {}) {
  let now = Date.parse('2026-10-01T00:00:00Z');
  const clock = () => now;
  const auth = new ApiKeyAuth({ now: clock });
  const engine = new PolicyEngine();
  const app = buildServer(engine, { auth, sandbox: { now: clock, ...sandbox } });
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
  const create = (body: object = {}, ip?: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/sandbox',
      payload: body,
      ...(ip ? { remoteAddress: ip } : {}),
    });
  const intent = (agentId: string, amount: string) => ({
    agentId,
    vendor: { host: 'vendor.reinconsole.com', address: '0xabc' },
    resource: '/testnet/v1/ping',
    amount,
    asset: 'USDC',
    chain: 'base',
  });
  return { app, auth, engine, bearer, create, intent, advance: (ms: number) => (now += ms) };
}

describe('POST /v1/sandbox', () => {
  it('mints an org with no credentials: agent, starter policy, org-scoped expiring key', async () => {
    const { app, create, bearer } = world();
    const res = await create({ name: 'my-agent' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.orgId).toMatch(/^org_/);
    expect(body.agentId).toMatch(/^agt_/);
    expect(body.apiKey).toMatch(/^rk_/);
    expect(Date.parse(body.expiresAt)).toBe(Date.parse('2026-10-01T00:00:00Z') + DEFAULT_SANDBOX_TTL_MS);
    expect(body.drip).toBeUndefined();

    const agents = await app.inject({ method: 'GET', url: '/v1/agents', headers: bearer(body.apiKey) });
    expect(agents.json().map((a: { id: string }) => a.id)).toEqual([body.agentId]);
    const policies = await app.inject({ method: 'GET', url: '/v1/policies', headers: bearer(body.apiKey) });
    expect(policies.json().map((p: { policyId: string }) => p.policyId)).toEqual([body.policyId]);
    await app.close();
  });

  it('governs the first-run demo: the $0.001 ping passes, the $0.005 call is denied', async () => {
    const { app, create, bearer, intent } = world();
    const { agentId, apiKey } = (await create()).json();
    const ping = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: bearer(apiKey),
      payload: intent(agentId, '0.001'),
    });
    expect(ping.json().decision.outcome).toBe('allow');
    const scores = await app.inject({
      method: 'POST',
      url: '/v1/evaluate',
      headers: bearer(apiKey),
      payload: intent(agentId, '0.005'),
    });
    expect(scores.json().decision.outcome).toBe('deny');
    expect(scores.json().decision.matchedRules).toContain('per-call-cap');
    await app.close();
  });

  it('stops authenticating the key after the TTL', async () => {
    const { app, create, bearer, advance } = world();
    const { apiKey } = (await create()).json();
    advance(DEFAULT_SANDBOX_TTL_MS);
    const res = await app.inject({ method: 'GET', url: '/v1/agents', headers: bearer(apiKey) });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('key_expired');
    await app.close();
  });

  it('a key minted by a sandbox key inherits its deadline, and "sandbox" is a reserved name', async () => {
    const { app, create, bearer, auth } = world();
    const { apiKey, expiresAt } = (await create()).json();
    const minted = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: bearer(apiKey),
      payload: { name: 'runtime', scopes: ['evaluate'] },
    });
    expect(minted.statusCode).toBe(201);
    expect(new Date(minted.json().key.expiresAt).toISOString()).toBe(expiresAt);

    const squat = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: bearer(apiKey),
      payload: { name: 'sandbox', scopes: ['read'] },
    });
    expect(squat.statusCode).toBe(400);
    expect(squat.json().error).toBe('reserved_key_name');

    // An operator key is unaffected: no deadline to inherit.
    const root = await auth.issue({ name: 'operator', scopes: ['admin'] });
    const operatorMinted = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: bearer(root.secret),
      payload: { name: 'plain', scopes: ['read'] },
    });
    expect(operatorMinted.json().key.expiresAt).toBeUndefined();
    await app.close();
  });

  it('caps the agents a sandbox org may register', async () => {
    const { app, create, bearer } = world({ maxAgents: 2 });
    const { apiKey } = (await create()).json();
    const add = () =>
      app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: bearer(apiKey),
        payload: { name: 'extra' },
      });
    expect((await add()).statusCode).toBe(200);
    const over = await add();
    expect(over.statusCode).toBe(403);
    expect(over.json().error).toBe('sandbox_quota');
    await app.close();
  });

  it('limits per IP, then per day globally -- and the global count survives in the keys', async () => {
    const { app, create } = world({ perIpPerDay: 2, dailyCap: 3 });
    expect((await create({}, '10.0.0.1')).statusCode).toBe(201);
    expect((await create({}, '10.0.0.1')).statusCode).toBe(201);
    const limited = await create({}, '10.0.0.1');
    expect(limited.statusCode).toBe(429);
    expect(limited.headers['retry-after']).toBeDefined();

    expect((await create({}, '10.0.0.2')).statusCode).toBe(201);
    const full = await create({}, '10.0.0.3');
    expect(full.statusCode).toBe(503);
    expect(full.json().error).toBe('sandbox_capacity');
    await app.close();
  });

  it('drips test USDC to the given wallet, and a failed drip still returns the org', async () => {
    const drips: string[] = [];
    const ok = world({
      drip: async (address) => {
        drips.push(address);
        return { txHash: '0xfeed', amount: '0.05' };
      },
    });
    const res = await ok.create({ wallet: WALLET });
    expect(res.json().drip).toEqual({ txHash: '0xfeed', amount: '0.05' });
    expect(drips).toEqual([WALLET]);
    // No wallet, no drip.
    expect((await ok.create({})).json().drip).toBeUndefined();
    await ok.app.close();

    const broken = world({
      drip: async () => {
        throw new Error('faucet is empty');
      },
    });
    const failed = await broken.create({ wallet: WALLET });
    expect(failed.statusCode).toBe(201);
    expect(failed.json().drip).toEqual({ error: 'faucet is empty' });
    await broken.app.close();
  });

  it('refuses a malformed wallet', async () => {
    const { app, create } = world();
    expect((await create({ wallet: '0x123' })).statusCode).toBe(400);
    await app.close();
  });

  it('does not exist unless configured, and the route is classified when it does', async () => {
    const auth = new ApiKeyAuth();
    const off = buildServer(new PolicyEngine(), { auth });
    expect((await off.inject({ method: 'POST', url: '/v1/sandbox', payload: {} })).statusCode).toBe(401);
    await off.close();

    const { app } = world();
    await app.ready();
    const paths = registeredRoutes(app).filter((r) => r.path === '/v1/sandbox');
    expect(paths).toHaveLength(1);
    expect(tenantRoute('POST', '/v1/sandbox')).toBe(true);
    await app.close();
  });
});
