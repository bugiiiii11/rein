/**
 * Sign-in, claim and the owner's own dashboard (Sprint 13), against a REAL
 * engine: the claim's whole point is what the engine does with it -- the
 * sandbox key stops expiring, and the dashboard is rendered through a key the
 * engine itself confined to one org. A fake engine would test the console's
 * hopes about that, not the fact.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { buildServer, PolicyEngine } from '@reinconsole/policy-engine';
import { createApiHandler } from './api';
import { createAccountHandler } from './account';
import { createOwnerBridge, type OwnerBridge } from './owners';
import { createSignIn, SESSION_COOKIE, safeReturnTo, type SignIn } from './signin';
import type { World } from './world';

const SECRET = 'x'.repeat(40);

/** The public demo world: recognisable, and not anybody's org. */
const PUBLIC: World = {
  getState: () => ({ public: true }) as never,
  subscribe: () => () => undefined,
  freeze: async () => false,
  unfreeze: async () => false,
  pingAgent: async () => false,
  submitGrant: async () => {
    throw new Error('no');
  },
  runDemo: () => false,
  close: async () => undefined,
};

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

function listen(server: Server): Promise<string> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)),
  );
}

async function setup(opts: { github?: boolean; fetchImpl?: typeof fetch } = {}) {
  const auth = new ApiKeyAuth();
  const engineApp = buildServer(new PolicyEngine(), { auth, sandbox: {} });
  await engineApp.listen({ port: 0, host: '127.0.0.1' });
  const engineUrl = `http://127.0.0.1:${(engineApp.server.address() as AddressInfo).port}`;
  cleanups.push(() => engineApp.close());
  const identityKey = (await auth.issue({ name: 'console-identity', scopes: ['identity'] })).secret;

  const consoleServer = createServer();
  const origin = await listen(consoleServer);
  const signIn: SignIn = createSignIn({
    sessionSecret: SECRET,
    publicUrl: origin,
    ...(opts.github ? { github: { clientId: 'cid', clientSecret: 'csecret' } } : {}),
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
  });
  const owners: OwnerBridge = createOwnerBridge({ engineUrl, identityKey, pollMs: 60_000 });
  cleanups.push(async () => {
    await owners.close();
    consoleServer.closeAllConnections();
    await new Promise((r) => consoleServer.close(r));
  });
  const account = createAccountHandler(signIn, owners);
  const api = createApiHandler(PUBLIC, {
    readOnly: true,
    viewFor: async (req) => {
      const s = signIn.session(req);
      return s ? (await owners.viewFor(s.sub))?.world : undefined;
    },
  });
  consoleServer.on('request', (req, res) => {
    if (account(req, res)) return;
    if (!api(req, res)) {
      res.writeHead(404);
      res.end();
    }
  });

  let cookie = '';
  const call = async (path: string, init: { method?: string; body?: object; origin?: string | null } = {}) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (cookie) headers['Cookie'] = cookie;
    if (init.origin !== null) headers['Origin'] = init.origin ?? origin;
    const res = await fetch(`${origin}${path}`, {
      method: init.method ?? 'GET',
      headers,
      redirect: 'manual',
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    const set = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
    if (set) cookie = set.split(';')[0] ?? '';
    return res;
  };

  const sandbox = async () =>
    (await (await fetch(`${engineUrl}/v1/sandbox`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()) as {
      orgId: string;
      agentId: string;
      apiKey: string;
    };
  const claimCode = async (apiKey: string) =>
    ((await (await fetch(`${engineUrl}/v1/claims`, { method: 'POST', headers: { Authorization: `Bearer ${apiKey}` } })).json()) as { code: string }).code;

  const signInWithWallet = async (privateKey = generatePrivateKey()) => {
    const account = privateKeyToAccount(privateKey);
    const challenge = (await (await call('/api/auth/siwe/challenge', { method: 'POST', body: { address: account.address } })).json()) as {
      message: string;
      nonce: string;
    };
    const signature = await account.signMessage({ message: challenge.message });
    const res = await call('/api/auth/siwe/verify', { method: 'POST', body: { nonce: challenge.nonce, signature } });
    return { res, account, challenge };
  };

  return { auth, engineUrl, origin, call, sandbox, claimCode, signInWithWallet, signOut: () => (cookie = '') };
}

describe('sign in with Ethereum', () => {
  it('signs in with an extension-wallet signature over a server-issued message', async () => {
    const { call, signInWithWallet, origin } = await setup();
    const { res, account, challenge } = await signInWithWallet();
    expect(res.status).toBe(200);
    expect(challenge.message).toContain(new URL(origin).host);
    expect(challenge.message).toContain(account.address);
    const me = await (await call('/api/me')).json();
    expect(me.user.identity).toBe(`eth:${account.address.toLowerCase()}`);
    expect(me.org).toBeNull();
  });

  it('refuses a signature from a different key, and a nonce used twice', async () => {
    const { call } = await setup();
    const holder = privateKeyToAccount(generatePrivateKey());
    const thief = privateKeyToAccount(generatePrivateKey());
    const ch = await (await call('/api/auth/siwe/challenge', { method: 'POST', body: { address: holder.address } })).json();
    const forged = await thief.signMessage({ message: ch.message });
    const bad = await call('/api/auth/siwe/verify', { method: 'POST', body: { nonce: ch.nonce, signature: forged } });
    expect(bad.status).toBe(401);

    const good = await holder.signMessage({ message: ch.message });
    const replay = await call('/api/auth/siwe/verify', { method: 'POST', body: { nonce: ch.nonce, signature: good } });
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe('siwe_expired');
  });

  it('refuses account POSTs from another origin', async () => {
    const { call } = await setup();
    const res = await call('/api/auth/siwe/challenge', {
      method: 'POST',
      body: { address: '0x1111111111111111111111111111111111111111' },
      origin: 'https://evil.example',
    });
    expect(res.status).toBe(403);
    expect((await call('/api/auth/signout', { method: 'POST', origin: null })).status).toBe(403);
  });
});

describe('claim and the owner dashboard', () => {
  it('claims a sandbox and then sees ONLY that org; anonymous visitors keep the public world', async () => {
    const { call, sandbox, claimCode, signInWithWallet, signOut, auth } = await setup();
    const mine = await sandbox();
    const theirs = await sandbox();

    await signInWithWallet();
    const claimed = await call('/api/claim', { method: 'POST', body: { code: await claimCode(mine.apiKey) } });
    expect(claimed.status).toBe(200);
    expect((await claimed.json()).orgId).toBe(mine.orgId);
    // The engine lifted the sandbox key's expiry: that IS keeping the org.
    const sandboxKey = auth.list().find((k) => k.orgId === mine.orgId && k.name === 'sandbox');
    expect(sandboxKey?.expiresAt).toBeUndefined();

    const me = await (await call('/api/me')).json();
    expect(me.org.orgId).toBe(mine.orgId);
    const state = await (await call('/api/state')).json();
    const agentIds = state.agents.map((a: { id: string }) => a.id);
    expect(agentIds).toEqual([mine.agentId]);
    expect(agentIds).not.toContain(theirs.agentId);

    signOut();
    expect(await (await call('/api/state')).json()).toEqual({ public: true });
  });

  it('needs a session to claim', async () => {
    const { call, sandbox, claimCode } = await setup();
    const sb = await sandbox();
    const res = await call('/api/claim', { method: 'POST', body: { code: await claimCode(sb.apiKey) } });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('signin_required');
  });

  it('relays the engine refusing a second org for the same account', async () => {
    const { call, sandbox, claimCode, signInWithWallet } = await setup();
    const a = await sandbox();
    const b = await sandbox();
    await signInWithWallet();
    await call('/api/claim', { method: 'POST', body: { code: await claimCode(a.apiKey) } });
    const res = await call('/api/claim', { method: 'POST', body: { code: await claimCode(b.apiKey) } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('identity_has_org');
  });

  it('shows a signed-in visitor who owns nothing the public world', async () => {
    const { call, signInWithWallet } = await setup();
    await signInWithWallet();
    expect(await (await call('/api/state')).json()).toEqual({ public: true });
  });
});

describe('sign in with GitHub', () => {
  it('runs the OAuth round trip and keys the identity by numeric user id', async () => {
    const seen: string[] = [];
    const fakeGitHub = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      seen.push(url);
      if (url === 'https://github.com/login/oauth/access_token') {
        expect(JSON.parse(String(init?.body)).code).toBe('the-code');
        return new Response(JSON.stringify({ access_token: 'gho_x' }), { status: 200 });
      }
      if (url === 'https://api.github.com/user') {
        return new Response(JSON.stringify({ id: 4242, login: 'octo' }), { status: 200 });
      }
      return fetch(input, init);
    }) as typeof fetch;
    const { call, origin } = await setup({ github: true, fetchImpl: fakeGitHub });

    const start = await fetch(`${origin}/api/auth/github/start?returnTo=/claim?code=abc`, { redirect: 'manual' });
    expect(start.status).toBe(302);
    const to = new URL(start.headers.get('location') ?? '');
    expect(to.origin).toBe('https://github.com');
    expect(to.searchParams.get('scope')).toBeNull();
    const state = to.searchParams.get('state') ?? '';
    const stateCookie = start.headers.getSetCookie()[0]?.split(';')[0] ?? '';

    const back = await fetch(`${origin}/api/auth/github/callback?code=the-code&state=${state}`, {
      redirect: 'manual',
      headers: { Cookie: stateCookie },
    });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/claim?code=abc');
    const session = back.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))?.split(';')[0] ?? '';
    const me = await (await fetch(`${origin}/api/me`, { headers: { Cookie: session } })).json();
    expect(me.user).toEqual({ name: 'octo', identity: 'github:4242' });
    expect(seen).toContain('https://api.github.com/user');
    void call;
  });

  it('refuses a callback whose state does not match the browser that started it', async () => {
    const { origin } = await setup({ github: true, fetchImpl: (async () => new Response('{}')) as typeof fetch });
    const back = await fetch(`${origin}/api/auth/github/callback?code=c&state=forged`, { redirect: 'manual' });
    expect(back.status).toBe(302);
    expect(back.headers.get('location')).toBe('/?signin_error=oauth_state');
  });
});

describe('safeReturnTo', () => {
  it('keeps same-site paths and drops everything that could leave the site', () => {
    expect(safeReturnTo('/claim?code=x')).toBe('/claim?code=x');
    for (const bad of ['//evil.example', 'https://evil.example', '/\\evil.example', undefined, 42]) {
      expect(safeReturnTo(bad)).toBe('/');
    }
  });
});
