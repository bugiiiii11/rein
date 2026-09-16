import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { recoverTypedDataAddress } from 'viem';
import { generatePrivateKey } from 'viem/accounts';
import { newId } from '@reinconsole/core';
import { buildServer, PolicyEngine } from '@reinconsole/policy-engine';
import { createGuard, type FetchLike } from '@reinconsole/sdk';
import {
  BASE_SEPOLIA_USDC,
  decodePaymentHeader,
  transferWithAuthorizationTypes,
} from '@reinconsole/x402-rails';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { buildSignerServer } from './server.js';
import { SessionSigner } from './signer.js';
import { MAX_SESSION_LIFETIME_SECONDS } from './sessions.js';
import { SignerError } from './errors.js';
import { createRemoteSessionPayer } from './payer.js';
import { evaluateFor, makeRequirement, VENDOR_HOST } from './testkit.js';

/**
 * The whole tier over real HTTP: a policy engine and a signer on ephemeral
 * ports, a guard wired with the remote session payer, and an x402 vendor that
 * cryptographically verifies the EIP-3009 signature it is paid with.
 */
let engine: PolicyEngine;
let agentId: string;
let signer: SessionSigner;
let engineApp: ReturnType<typeof buildServer>;
let signerApp: ReturnType<typeof buildSignerServer>;
let engineUrl: string;
let signerUrl: string;
let walletAddress: string;

/** The admin secret this suite's signer is built with (>= 16 chars). */
const ADMIN_TOKEN = 'test-admin-secret-0123456789';

/** Every session-admin call goes through here — the routes refuse otherwise. */
function adminFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${signerUrl}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${ADMIN_TOKEN}` },
  });
}

beforeAll(async () => {
  engine = new PolicyEngine();
  const agent = await engine.registerAgent({
    id: newId('agt'),
    orgId: newId('org'),
    name: 'remote-signer-agent',
    wallets: [],
    status: 'active',
    createdAt: new Date(),
  });
  agentId = agent.id;
  await engine.addPolicy({
    policyId: 'pol_remote_test',
    appliesTo: {},
    rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
    default: 'allow',
  });

  signer = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });
  walletAddress = signer.registerWallet(agentId, generatePrivateKey());

  engineApp = buildServer(engine);
  signerApp = buildSignerServer(signer, { adminToken: ADMIN_TOKEN });
  await engineApp.listen({ port: 0, host: '127.0.0.1' });
  await signerApp.listen({ port: 0, host: '127.0.0.1' });
  engineUrl = `http://127.0.0.1:${(engineApp.server.address() as AddressInfo).port}`;
  signerUrl = `http://127.0.0.1:${(signerApp.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await engineApp.close();
  await signerApp.close();
});

async function createSession(body: Record<string, unknown> = {}): Promise<{
  session: Record<string, unknown>;
  token: string;
}> {
  const res = await adminFetch('/v1/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ agentId, ...body }),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { session: Record<string, unknown>; token: string };
}

/** An x402 vendor that only serves content for a verifiable EIP-3009 payment. */
function evmVendor() {
  const requirement = makeRequirement();
  const fetchImpl: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const payment = init?.headers ? new Headers(init.headers).get('X-PAYMENT') : null;
    if (payment === null) {
      return new Response(
        JSON.stringify({ x402Version: 1, accepts: [requirement], error: 'payment required' }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );
    }
    const payload = decodePaymentHeader(payment);
    const auth = payload.payload.authorization;
    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: BASE_SEPOLIA_USDC },
      types: transferWithAuthorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: auth.from as `0x${string}`,
        to: auth.to as `0x${string}`,
        value: BigInt(auth.value),
        validAfter: BigInt(auth.validAfter),
        validBefore: BigInt(auth.validBefore),
        nonce: auth.nonce as `0x${string}`,
      },
      signature: payload.payload.signature as `0x${string}`,
    });
    if (recovered.toLowerCase() !== auth.from.toLowerCase() || auth.value !== '10000') {
      return new Response(JSON.stringify({ error: 'bad signature' }), { status: 402 });
    }
    return new Response(JSON.stringify({ answer: 42 }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'X-PAYMENT-RESPONSE': Buffer.from(
          JSON.stringify({ success: true, transaction: '0xremotesettled', network: 'base-sepolia' }),
        ).toString('base64'),
      },
    });
  };
  return fetchImpl;
}

describe('signer over HTTP (remote payer + guard, end to end)', () => {
  it('creates sessions without leaking the token hash', async () => {
    const created = await createSession();
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    expect(created.session['tokenHash']).toBeUndefined();
    expect(created.session['agentId']).toBe(agentId);
    // The expiry a caller should plan rotation against travels with the grant.
    expect(created.session['effectiveExpiresAt']).toBe(created.session['expiresAt']);
  });

  it('rejects an over-long ttl as a 400 naming the cap, and advertises it on /health', async () => {
    const health = (await (await fetch(`${signerUrl}/health`)).json()) as {
      maxSessionLifetimeSeconds: number;
    };
    expect(health.maxSessionLifetimeSeconds).toBe(MAX_SESSION_LIFETIME_SECONDS);

    const res = await adminFetch('/v1/sessions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agentId, ttlSeconds: MAX_SESSION_LIFETIME_SECONDS + 1 }),
    });
    // 400, not the 500 an unmapped signer throw would have produced.
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toBe('validation_error');
  });

  it('pays a vendor through guard -> engine -> remote signer, key never leaving custody', async () => {
    const { token } = await createSession({ capAmount: '0.10' });
    const guard = createGuard({
      engineUrl,
      agentId,
      fetch: evmVendor(),
      payer: createRemoteSessionPayer({ signerUrl, sessionToken: token }),
    });

    const res = await guard.wrap()(`https://${VENDOR_HOST}/v1/answer`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 42 });
    const receipts = guard.receipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe('allow');
    expect(receipts[0]?.settlement?.txHash).toBe('0xremotesettled');
  });

  it('surfaces signer refusals as SignerError through the remote payer', async () => {
    const { token, session } = await createSession();
    const res = await adminFetch(`/v1/sessions/${session['id']}/revoke`, { method: 'POST' });
    expect(res.status).toBe(204);

    const guard = createGuard({
      engineUrl,
      agentId,
      fetch: evmVendor(),
      payer: createRemoteSessionPayer({ signerUrl, sessionToken: token }),
    });
    await expect(guard.wrap()(`https://${VENDOR_HOST}/v1/answer`)).rejects.toMatchObject({
      name: 'SignerError',
      code: 'session_revoked',
    });
  });

  it('answers a tampered voucher with 403 refused/voucher_invalid', async () => {
    const { token } = await createSession();
    const { intent, decision } = await evaluateFor(engine, agentId);
    const res = await fetch(`${signerUrl}/v1/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionToken: token,
        requirement: makeRequirement(),
        intent: { ...intent, amount: '0.99' },
        decision,
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'refused', code: 'voucher_invalid' });
  });

  it('rejects malformed sign requests with 400', async () => {
    const res = await fetch(`${signerUrl}/v1/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken: 'x', requirement: {}, intent: {}, decision: {} }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: 'validation_error' });
  });

  it('lists sessions with cumulative spend, 404s unknown revokes', async () => {
    const res = await adminFetch('/v1/sessions');
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s['tokenHash'] === undefined)).toBe(true);
    expect(sessions.some((s) => s['spent'] === '0.01')).toBe(true);

    const missing = await adminFetch(`/v1/sessions/${newId('ses')}/revoke`, {
      method: 'POST',
    });
    expect(missing.status).toBe(404);
  });

  it('deletes a dead grant over HTTP: 409 while active, 204 after revoke, then 404', async () => {
    const { session } = await createSession();
    const id = session['id'] as string;

    const active = await adminFetch(`/v1/sessions/${id}`, { method: 'DELETE' });
    expect(active.status).toBe(409);
    expect(await active.json()).toMatchObject({ error: 'session_active' });

    await adminFetch(`/v1/sessions/${id}/revoke`, { method: 'POST' });
    const deleted = await adminFetch(`/v1/sessions/${id}`, { method: 'DELETE' });
    expect(deleted.status).toBe(204);
    expect(signer.sessions().some((s) => s.id === id)).toBe(false);

    const again = await adminFetch(`/v1/sessions/${id}`, { method: 'DELETE' });
    expect(again.status).toBe(404);
  });

  it('verifies the signature in the header recovers to the custodied wallet', async () => {
    const { token } = await createSession();
    const { intent, decision } = await evaluateFor(engine, agentId);
    const res = await fetch(`${signerUrl}/v1/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionToken: token, requirement: makeRequirement(), intent, decision }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { paymentHeader: string; from: string };
    expect(body.from).toBe(walletAddress);
    const payload = decodePaymentHeader(body.paymentHeader);
    expect(payload.payload.authorization.from).toBe(walletAddress);
  });
});

/**
 * D1. The admin surface mints spending authority against a wallet this
 * process holds the key to, so "someone forgot the token" must not be a way
 * to get an open one.
 */
describe('signer admin auth', () => {
  it('refuses to build a server with neither a token nor an explicit opt-out', () => {
    const s = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });
    expect(() => buildSignerServer(s)).toThrow(/adminToken/);
    expect(() => buildSignerServer(s, {})).toThrow(/adminAuth/);
  });

  it('refuses a token short enough to guess, and refuses both-at-once', () => {
    const s = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });
    expect(() => buildSignerServer(s, { adminToken: 'admin' })).toThrow(/at least 16/);
    expect(() => buildSignerServer(s, { adminToken: ADMIN_TOKEN, adminAuth: 'off' })).toThrow(
      /not both/,
    );
  });

  it('builds open only when asked to in so many words', async () => {
    const s = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });
    const open = buildSignerServer(s, { adminAuth: 'off' });
    const health = await open.inject({ method: 'GET', url: '/health' });
    expect(health.json()).toMatchObject({ adminAuth: 'off' });
    const minted = await open.inject({
      method: 'POST',
      url: '/v1/sessions',
      payload: { agentId },
    });
    expect(minted.statusCode).toBe(200);
    await open.close();
  });

  it('401s every admin route without a credential, and challenges', async () => {
    for (const [method, url] of [
      ['POST', '/v1/sessions'],
      ['GET', '/v1/sessions'],
      ['POST', `/v1/sessions/${newId('ses')}/revoke`],
      ['DELETE', `/v1/sessions/${newId('ses')}`],
    ] as const) {
      const res = await fetch(`${signerUrl}${url}`, {
        method,
        headers: { 'content-type': 'application/json' },
        ...(method === 'POST' && url === '/v1/sessions'
          ? { body: JSON.stringify({ agentId }) }
          : {}),
      });
      expect(res.status, `${method} ${url}`).toBe(401);
      expect(res.headers.get('www-authenticate')).toMatch(/Bearer/);
      expect(await res.json()).toMatchObject({ code: 'missing_credentials' });
    }
  });

  it('401s a wrong token — including a prefix of the right one', async () => {
    for (const bad of ['nope-nope-nope-nope', ADMIN_TOKEN.slice(0, -1), ADMIN_TOKEN + 'x']) {
      const res = await fetch(`${signerUrl}/v1/sessions`, {
        headers: { authorization: `Bearer ${bad}` },
      });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ code: 'invalid_credentials' });
    }
  });

  it('accepts X-Api-Key too, since some runtimes only send that', async () => {
    const res = await fetch(`${signerUrl}/v1/sessions`, {
      headers: { 'x-api-key': ADMIN_TOKEN },
    });
    expect(res.status).toBe(200);
  });

  it('leaves /health and the signing hot path open — the session token is that credential', async () => {
    const health = await fetch(`${signerUrl}/health`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ adminAuth: 'bearer' });

    // No admin header: refused for the session token, not for the credential.
    const { intent, decision } = await evaluateFor(engine, agentId);
    const res = await fetch(`${signerUrl}/v1/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionToken: 'not-a-real-token',
        requirement: makeRequirement(),
        intent,
        decision,
      }),
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: 'session_unknown' });
  });
});

describe('SignerError', () => {
  it('is what the remote payer throws on refusal', () => {
    const err = new SignerError('session_expired', 'session has expired');
    expect(err.name).toBe('SignerError');
    expect(err.code).toBe('session_expired');
  });
});

/**
 * D1(b). The static token is one secret that cannot be narrowed and cannot be
 * rotated without a flag-day; these are the properties a key store adds. The
 * signer is a library with no boot path, so `auth` arrives from the composing
 * deployment — backed by PgApiKeyStore where it must outlive a restart.
 */
describe('signer admin auth by API key', () => {
  const build = async (options: Parameters<typeof buildSignerServer>[1]) => {
    const s = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });
    return buildSignerServer(s, options);
  };
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

  it('takes an admin-scoped key everywhere the static token went', async () => {
    const auth = new ApiKeyAuth();
    const { secret } = await auth.issue({ name: 'ops', scopes: ['admin'] });
    const app = await build({ auth });

    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      adminAuth: 'api-key',
    });
    const minted = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: bearer(secret),
      payload: { agentId },
    });
    expect(minted.statusCode).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url: '/v1/sessions', headers: bearer(secret) })).statusCode,
    ).toBe(200);
    await app.close();
  });

  /**
   * The point of the whole exercise: a dashboard key that can see the grants
   * cannot mint one against a wallet this process holds.
   */
  it('lets a read key list grants and refuses to let it mint one', async () => {
    const auth = new ApiKeyAuth();
    const { secret } = await auth.issue({ name: 'dashboard', scopes: ['read'] });
    const app = await build({ auth });

    const listed = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: bearer(secret),
    });
    expect(listed.statusCode).toBe(200);

    const minted = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: bearer(secret),
      payload: { agentId },
    });
    expect(minted.statusCode).toBe(403);
    expect(minted.json()).toMatchObject({ error: 'forbidden', code: 'insufficient_scope' });
    // A 403 gets no challenge: the caller is known and re-presenting the same
    // key is not the answer.
    expect(minted.headers['www-authenticate']).toBeUndefined();

    // Revoke and the same key stops listing too.
    await auth.revoke(auth.list()[0]!.id);
    const after = await app.inject({ method: 'GET', url: '/v1/sessions', headers: bearer(secret) });
    expect(after.statusCode).toBe(401);
    expect(after.json()).toMatchObject({ code: 'key_revoked' });
    await app.close();
  });

  it('keeps the static token working beside the keys, and says so', async () => {
    const auth = new ApiKeyAuth();
    const { secret } = await auth.issue({ name: 'ops', scopes: ['admin'] });
    const app = await build({ auth, adminToken: ADMIN_TOKEN });

    expect((await app.inject({ method: 'GET', url: '/health' })).json()).toMatchObject({
      adminAuth: 'bearer+api-key',
    });
    for (const credential of [ADMIN_TOKEN, secret]) {
      const res = await app.inject({
        method: 'GET',
        url: '/v1/sessions',
        headers: bearer(credential),
      });
      expect(res.statusCode, credential === ADMIN_TOKEN ? 'static' : 'key').toBe(200);
    }
    const wrong = await app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: bearer('neither-of-the-two'),
    });
    expect(wrong.statusCode).toBe(401);
    await app.close();
  });

  it('treats a key store as a credential for construction, and still refuses both-at-once', async () => {
    const auth = new ApiKeyAuth();
    await auth.issue({ name: 'ops', scopes: ['admin'] });
    const s = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem });
    expect(() => buildSignerServer(s, { auth, adminAuth: 'off' })).toThrow(/not both/);
  });

  /**
   * An auth object holding no keys is a LOCKED signer, never an open one —
   * the fail-closed direction, the same one the constructor enforces.
   */
  it('fails closed when the key store is empty rather than falling open', async () => {
    const app = await build({ auth: new ApiKeyAuth() });
    const minted = await app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: bearer('anything-at-all'),
      payload: { agentId },
    });
    expect(minted.statusCode).toBe(401);
    expect(minted.json()).toMatchObject({ code: 'invalid_key' });
    await app.close();
  });
});
