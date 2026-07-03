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
import { buildSignerServer } from './server.js';
import { SessionSigner } from './signer.js';
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
  signerApp = buildSignerServer(signer);
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
  const res = await fetch(`${signerUrl}/v1/sessions`, {
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
    const res = await fetch(`${signerUrl}/v1/sessions/${session['id']}/revoke`, { method: 'POST' });
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
    const res = await fetch(`${signerUrl}/v1/sessions`);
    expect(res.status).toBe(200);
    const sessions = (await res.json()) as Array<Record<string, unknown>>;
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((s) => s['tokenHash'] === undefined)).toBe(true);
    expect(sessions.some((s) => s['spent'] === '0.01')).toBe(true);

    const missing = await fetch(`${signerUrl}/v1/sessions/${newId('ses')}/revoke`, {
      method: 'POST',
    });
    expect(missing.status).toBe(404);
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

describe('SignerError', () => {
  it('is what the remote payer throws on refusal', () => {
    const err = new SignerError('session_expired', 'session has expired');
    expect(err.name).toBe('SignerError');
    expect(err.code).toBe('session_expired');
  });
});
