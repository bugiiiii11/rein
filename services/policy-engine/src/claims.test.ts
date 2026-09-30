import { describe, it, expect } from 'vitest';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { buildServer, registeredRoutes, tenantRoute } from './server.js';
import { PolicyEngine } from './engine.js';
import { DEFAULT_SANDBOX_TTL_MS } from './sandbox.js';
import { DEFAULT_CLAIM_CODE_TTL_MS, DEFAULT_OWNER_SESSION_TTL_MS } from './claims.js';

const GH = 'github:4242';
const ETH = 'eth:0x2222222222222222222222222222222222222222';

async function world() {
  let now = Date.parse('2026-10-01T00:00:00Z');
  const clock = () => now;
  const auth = new ApiKeyAuth({ now: clock });
  const engine = new PolicyEngine();
  const app = buildServer(engine, { auth, sandbox: { now: clock } });
  // The hosted console's key: unscoped, `identity` and nothing else.
  const consoleKey = (await auth.issue({ name: 'console-identity', scopes: ['identity'] })).secret;
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
  const sandbox = async () =>
    (await app.inject({ method: 'POST', url: '/v1/sandbox', payload: {} })).json() as {
      orgId: string;
      agentId: string;
      apiKey: string;
    };
  const start = (key: string) => app.inject({ method: 'POST', url: '/v1/claims', headers: bearer(key) });
  const redeem = (code: string, identity: string, key = consoleKey) =>
    app.inject({ method: 'POST', url: '/v1/claims/redeem', headers: bearer(key), payload: { code, identity } });
  const session = (identity: string, key = consoleKey) =>
    app.inject({ method: 'POST', url: '/v1/owners/session', headers: bearer(key), payload: { identity } });
  return { app, auth, bearer, sandbox, start, redeem, session, advance: (ms: number) => (now += ms) };
}

describe('claiming a sandbox', () => {
  it('keeps the org: the sandbox key stops expiring once an identity redeems the code', async () => {
    const { app, bearer, sandbox, start, redeem, advance } = await world();
    const sb = await sandbox();
    const started = await start(sb.apiKey);
    expect(started.statusCode).toBe(201);
    expect(started.json().orgId).toBe(sb.orgId);

    const res = await redeem(started.json().code, GH);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orgId: sb.orgId, identity: GH, lifted: 1, alreadyOwned: false });

    advance(DEFAULT_SANDBOX_TTL_MS + 1);
    const agents = await app.inject({ method: 'GET', url: '/v1/agents', headers: bearer(sb.apiKey) });
    expect(agents.statusCode).toBe(200);
    await app.close();
  });

  it('lifts keys the sandbox minted too, but never a revoked one', async () => {
    const { app, auth, bearer, sandbox, start, redeem } = await world();
    const sb = await sandbox();
    const minted = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: bearer(sb.apiKey),
      payload: { name: 'runtime', scopes: ['evaluate'] },
    });
    const dead = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: bearer(sb.apiKey),
      payload: { name: 'retired', scopes: ['read'] },
    });
    await auth.revoke(dead.json().key.id);

    const { lifted } = (await redeem((await start(sb.apiKey)).json().code, GH)).json();
    expect(lifted).toBe(2);
    expect(auth.get(minted.json().key.id)?.expiresAt).toBeUndefined();
    expect(auth.get(dead.json().key.id)?.expiresAt).toBeDefined();
    await app.close();
  });

  it('lifts the sandbox quotas with the expiry', async () => {
    const { app, bearer, sandbox, start, redeem } = await world();
    const sb = await sandbox();
    await redeem((await start(sb.apiKey)).json().code, GH);
    for (let i = 0; i < 3; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: bearer(sb.apiKey),
        payload: { name: `extra-${i}` },
      });
      expect(res.statusCode).toBe(200);
    }
    await app.close();
  });

  it('spends a code once, and forgets it after ten minutes', async () => {
    const { app, sandbox, start, redeem, advance } = await world();
    const a = await sandbox();
    const code = (await start(a.apiKey)).json().code;
    expect((await redeem(code, GH)).statusCode).toBe(200);
    expect((await redeem(code, ETH)).json().error).toBe('unknown_claim_code');

    const b = await sandbox();
    const late = (await start(b.apiKey)).json().code;
    advance(DEFAULT_CLAIM_CODE_TTL_MS);
    const res = await redeem(late, ETH);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('unknown_claim_code');
    await app.close();
  });

  it('holds one org per identity and one owner per org', async () => {
    const { app, sandbox, start, redeem } = await world();
    const a = await sandbox();
    const b = await sandbox();
    await redeem((await start(a.apiKey)).json().code, GH);

    const second = await redeem((await start(b.apiKey)).json().code, GH);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe('identity_has_org');

    const again = await start(a.apiKey);
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_claimed');
    await app.close();
  });

  it('lets two identities race for one org and only one win', async () => {
    const { app, sandbox, start, redeem } = await world();
    const sb = await sandbox();
    const first = (await start(sb.apiKey)).json().code;
    const second = (await start(sb.apiKey)).json().code; // replaces the first
    const [x, y] = await Promise.all([redeem(first, GH), redeem(second, ETH)]);
    expect(x.statusCode).toBe(404);
    expect(y.statusCode).toBe(200);
    await app.close();
  });

  it('starts only from the org-wide admin key', async () => {
    const { app, bearer, sandbox, start } = await world();
    const sb = await sandbox();
    const narrowed = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: bearer(sb.apiKey),
      payload: { name: 'runtime', scopes: ['admin'], agentIds: [sb.agentId] },
    });
    const res = await start(narrowed.json().secret);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('claim_needs_org_admin');

    const reader = await app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: bearer(sb.apiKey),
      payload: { name: 'reader', scopes: ['read'] },
    });
    expect((await start(reader.json().secret)).statusCode).toBe(403);
    await app.close();
  });

  it('keeps redeem and sessions out of reach of every org-scoped key, the sandbox admin included', async () => {
    const { app, sandbox, start, redeem, session } = await world();
    const sb = await sandbox();
    const code = (await start(sb.apiKey)).json().code;
    const res = await redeem(code, GH, sb.apiKey);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('route_not_scopable');
    expect((await session(GH, sb.apiKey)).json().error).toBe('route_not_scopable');
    await app.close();
  });

  it('refuses the reserved key names, so nobody claims by minting an owner key', async () => {
    const { app, bearer, sandbox } = await world();
    const sb = await sandbox();
    for (const name of [`owner:${GH}`, `session:${GH}`]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/keys',
        headers: bearer(sb.apiKey),
        payload: { name, scopes: ['read'] },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('reserved_key_name');
    }
    await app.close();
  });

  it('validates the identity shape', async () => {
    const { app, sandbox, start, redeem } = await world();
    const sb = await sandbox();
    const code = (await start(sb.apiKey)).json().code;
    for (const identity of ['github:octocat', 'eth:0xABC', 'google:1']) {
      expect((await redeem(code, identity)).statusCode).toBe(400);
    }
    await app.close();
  });

  it('shows the owner to the org as a key it can revoke, and revoking it releases the org', async () => {
    const { app, bearer, sandbox, start, redeem } = await world();
    const a = await sandbox();
    await redeem((await start(a.apiKey)).json().code, GH);
    const keys = (await app.inject({ method: 'GET', url: '/v1/keys', headers: bearer(a.apiKey) })).json();
    const owner = keys.find((k: { name: string }) => k.name === `owner:${GH}`);
    expect(owner).toBeDefined();

    await app.inject({ method: 'POST', url: `/v1/keys/${owner.id}/revoke`, headers: bearer(a.apiKey) });
    const b = await sandbox();
    expect((await redeem((await start(b.apiKey)).json().code, GH)).statusCode).toBe(200);
    await app.close();
  });
});

describe('owner sessions', () => {
  it('hands the owner a short-lived read key that sees only their org', async () => {
    const { app, bearer, sandbox, start, redeem, session, advance } = await world();
    const mine = await sandbox();
    const theirs = await sandbox();
    await redeem((await start(mine.apiKey)).json().code, ETH);

    const res = await session(ETH);
    expect(res.statusCode).toBe(201);
    const s = res.json();
    expect(s.orgId).toBe(mine.orgId);

    const agents = await app.inject({ method: 'GET', url: '/v1/agents', headers: bearer(s.apiKey) });
    expect(agents.json().map((a: { id: string }) => a.id)).toEqual([mine.agentId]);
    expect(agents.json().map((a: { id: string }) => a.id)).not.toContain(theirs.agentId);

    const write = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: bearer(s.apiKey),
      payload: { name: 'nope' },
    });
    expect(write.statusCode).toBe(403);

    advance(DEFAULT_OWNER_SESSION_TTL_MS);
    const later = await app.inject({ method: 'GET', url: '/v1/agents', headers: bearer(s.apiKey) });
    expect(later.json().error).toBe('key_expired');
    await app.close();
  });

  it('answers 404 for an identity that owns nothing', async () => {
    const { app, session } = await world();
    const res = await session(GH);
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_an_owner');
    await app.close();
  });

  it('needs the identity scope: a plain operator read key is refused', async () => {
    const { app, auth, session } = await world();
    const reader = (await auth.issue({ name: 'ops-read', scopes: ['read'] })).secret;
    expect((await session(GH, reader)).json().error).toBe('insufficient_scope');
    await app.close();
  });
});

describe('the route table with claims on', () => {
  it('leaves exactly redeem and sessions unclassified -- the operator-only pair', async () => {
    const { app } = await world();
    await app.ready();
    const unclassified = registeredRoutes(app)
      .filter((r) => !tenantRoute(r.method, r.path.replace(/:[^/]+/g, 'x')))
      .map((r) => `${r.method} ${r.path}`);
    expect(unclassified.sort()).toEqual(['POST /v1/claims/redeem', 'POST /v1/owners/session']);
    await app.close();
  });
});
