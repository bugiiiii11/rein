import { describe, it, expect } from 'vitest';
import { newId } from '@reinconsole/core';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { buildServer } from './server.js';
import { PolicyEngine } from './engine.js';
import { DEFAULT_SANDBOX_TTL_MS } from './sandbox.js';
import { DEFAULT_OWNER_SESSION_TTL_MS } from './claims.js';
import { DEFAULT_SANDBOX_GRACE_MS, DEFAULT_SESSION_KEY_GRACE_MS, reapExpired } from './reaper.js';

const GH = 'github:4242';

async function world() {
  let now = Date.parse('2026-10-01T00:00:00Z');
  const clock = () => now;
  const auth = new ApiKeyAuth({ now: clock });
  const engine = new PolicyEngine();
  const app = buildServer(engine, { auth, sandbox: { now: clock }, reapIntervalMs: 0 });
  const consoleKey = (await auth.issue({ name: 'console-identity', scopes: ['identity'] })).secret;
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
  const sandbox = async () =>
    (await app.inject({ method: 'POST', url: '/v1/sandbox', payload: {} })).json() as {
      orgId: string;
      agentId: string;
      policyId: string;
      apiKey: string;
    };
  const claim = async (key: string, identity: string) => {
    const { code } = (await app.inject({ method: 'POST', url: '/v1/claims', headers: bearer(key) })).json();
    await app.inject({
      method: 'POST',
      url: '/v1/claims/redeem',
      headers: bearer(consoleKey),
      payload: { code, identity },
    });
  };
  const session = (identity: string) =>
    app.inject({ method: 'POST', url: '/v1/owners/session', headers: bearer(consoleKey), payload: { identity } });
  const reap = () => reapExpired(engine, auth, { sandboxes: true, now: clock });
  const keyNames = (orgId: string) =>
    auth
      .list()
      .filter((k) => k.orgId === orgId)
      .map((k) => k.name)
      .sort();
  return { app, auth, engine, sandbox, claim, session, reap, keyNames, advance: (ms: number) => (now += ms) };
}

describe('reapExpired', () => {
  it('deletes owner session keys a day after they expire, and nothing else in the org', async () => {
    const { app, sandbox, claim, session, reap, keyNames, advance } = await world();
    const sb = await sandbox();
    await claim(sb.apiKey, GH);
    await session(GH);
    await session(GH);
    expect(keyNames(sb.orgId)).toEqual([`owner:${GH}`, 'sandbox', `session:${GH}`, `session:${GH}`]);

    advance(DEFAULT_OWNER_SESSION_TTL_MS + DEFAULT_SESSION_KEY_GRACE_MS - 1);
    expect((await reap()).sessionKeys).toBe(0);
    advance(1);
    expect(await reap()).toEqual({ sessionKeys: 2, orgs: 0, agents: 0, policies: 0, keys: 0 });
    expect(keyNames(sb.orgId)).toEqual([`owner:${GH}`, 'sandbox']);
    await app.close();
  });

  it('removes an unclaimed sandbox a month after its keys expire: agents, policies, keys -- not decisions', async () => {
    const { app, engine, sandbox, reap, keyNames, advance } = await world();
    const sb = await sandbox();
    await engine.evaluateIntent({
      agentId: sb.agentId,
      vendor: { host: 'vendor.reinconsole.com', address: '0xabc' },
      resource: '/testnet/v1/ping',
      amount: '0.001',
      asset: 'USDC',
      chain: 'base',
    });
    const decisions = engine.decisions().length;

    advance(DEFAULT_SANDBOX_TTL_MS + DEFAULT_SANDBOX_GRACE_MS - 1);
    expect((await reap()).orgs).toBe(0);
    advance(1);
    expect(await reap()).toEqual({ sessionKeys: 0, orgs: 1, agents: 1, policies: 1, keys: 1 });
    expect(engine.agents.get(sb.agentId)).toBeUndefined();
    expect(engine.policies.get(sb.policyId)).toBeUndefined();
    expect(keyNames(sb.orgId)).toEqual([]);
    expect(engine.decisions().length).toBe(decisions);
    await app.close();
  });

  it('never touches a claimed org, however old', async () => {
    const { app, engine, sandbox, claim, reap, keyNames, advance } = await world();
    const sb = await sandbox();
    await claim(sb.apiKey, GH);
    advance(DEFAULT_SANDBOX_TTL_MS + DEFAULT_SANDBOX_GRACE_MS + 1);
    expect((await reap()).orgs).toBe(0);
    expect(engine.agents.get(sb.agentId)).toBeDefined();
    expect(keyNames(sb.orgId)).toEqual([`owner:${GH}`, 'sandbox']);
    await app.close();
  });

  it('never touches an org with no sandbox key, even when all its keys have expired', async () => {
    const { app, auth, engine, reap, keyNames, advance } = await world();
    const orgId = newId('org');
    const agent = await engine.registerAgent({
      id: newId('agt'),
      orgId,
      name: 'mine',
      wallets: [],
      status: 'active',
      createdAt: new Date(0),
    });
    await auth.issue({ name: 'ci', scopes: ['read'], orgId, expiresAt: new Date(Date.parse('2026-10-02T00:00:00Z')) });
    advance(DEFAULT_SANDBOX_GRACE_MS * 3);
    expect((await reap()).orgs).toBe(0);
    expect(engine.agents.get(agent.id)).toBeDefined();
    expect(keyNames(orgId)).toEqual(['ci']);
    await app.close();
  });

  it('leaves dead sandboxes alone when sandboxes is off (session keys still go)', async () => {
    const { app, auth, engine, sandbox, advance } = await world();
    const sb = await sandbox();
    advance(DEFAULT_SANDBOX_TTL_MS + DEFAULT_SANDBOX_GRACE_MS + 1);
    expect((await reapExpired(engine, auth, { now: () => Date.parse('2027-01-01T00:00:00Z') })).orgs).toBe(0);
    expect(engine.agents.get(sb.agentId)).toBeDefined();
    await app.close();
  });
});

describe('ApiKeyAuth.remove', () => {
  it('refuses a key that has not expired, and one that never will', async () => {
    let now = 0;
    const auth = new ApiKeyAuth({ now: () => now });
    const permanent = await auth.issue({ name: 'op', scopes: ['admin'] });
    const expiring = await auth.issue({ name: 'tmp', scopes: ['read'], orgId: newId('org'), expiresAt: new Date(1000) });
    await expect(auth.remove(permanent.key.id)).rejects.toThrow(/only an expired key/);
    await expect(auth.remove(expiring.key.id)).rejects.toThrow(/only an expired key/);
    now = 1000;
    expect(await auth.remove(expiring.key.id)).toBe(true);
    expect(auth.get(expiring.key.id)).toBeUndefined();
    expect(() => auth.authenticate({ authorization: `Bearer ${expiring.secret}` }, 'read')).toThrow(/unknown API key/);
  });
});
