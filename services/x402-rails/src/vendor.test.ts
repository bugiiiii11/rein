import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import { newId } from '@reinconsole/core';
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import {
  PaymentRequired,
  buildPaymentRequiredV2,
  createGuard,
  encodeBase64Json,
  parsePaymentRequiredHeader,
  wrapPaymentV2,
  type FetchLike,
} from '@reinconsole/sdk';
import { FacilitatorClient } from './facilitator.js';
import { createX402Payer } from './payer.js';
import { createRealVendor } from './vendor.js';
import { BASE_SEPOLIA_USDC, generateWallet } from './wallet.js';
import { encodePaymentHeader, type PaymentPayload } from './wire.js';

const URL_ANSWER = 'https://api.vendor.test/v1/answer';
const PAY_TO = '0x2222222222222222222222222222222222222222';

const payload: PaymentPayload = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base-sepolia',
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: '0x1111111111111111111111111111111111111111',
      to: PAY_TO,
      value: '10000',
      validAfter: '1749999400',
      validBefore: '1750000300',
      nonce: `0x${'cd'.repeat(32)}`,
    },
  },
};

function facilitatorStub(responses: Record<string, unknown>) {
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const fetch: FetchLike = (input, init) => {
    const path = new URL(String(input)).pathname.split('/').at(-1) ?? '';
    if (typeof init?.body === 'string') {
      posts.push({ path, body: JSON.parse(init.body) as Record<string, unknown> });
    }
    const body = responses[path];
    if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  return { client: new FacilitatorClient({ url: 'https://fac.test', fetch }), posts };
}

describe('createRealVendor', () => {
  it('quotes a 402 the SDK parses and the hosted facilitator accepts', async () => {
    const vendor = createRealVendor({
      facilitator: facilitatorStub({}).client,
      atomicPrice: '10000',
      payTo: PAY_TO,
    });

    const res = await vendor.fetch(URL_ANSWER);
    expect(res.status).toBe(402);
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull(); // default is strict v1

    const parsed = PaymentRequired.parse(await res.json());
    const offer = parsed.accepts[0]!;
    // The hosted facilitator validates these strictly; missing any 400s.
    expect(offer.scheme).toBe('exact');
    expect(offer.network).toBe('base-sepolia');
    expect(() => new URL(offer.resource ?? '')).not.toThrow();
    expect(offer.description).toBeTypeOf('string');
    expect(offer.mimeType).toBeTypeOf('string');
    expect(Number.isInteger(offer.maxTimeoutSeconds)).toBe(true);
    expect(offer.payTo).toBe(PAY_TO);
    expect(offer.asset).toBe(BASE_SEPOLIA_USDC);
    expect(offer.extra).toEqual({ name: 'USDC', version: '2' });
  });

  it('verifies then settles a payment, returning X-PAYMENT-RESPONSE', async () => {
    const tx = `0x${'12'.repeat(32)}`;
    const vendor = createRealVendor({
      facilitator: facilitatorStub({
        verify: { isValid: true },
        settle: { success: true, transaction: tx, network: 'base-sepolia' },
      }).client,
      atomicPrice: '10000',
      payTo: PAY_TO,
      body: { report: 42 },
    });

    const res = await vendor.fetch(URL_ANSWER, {
      headers: { 'X-PAYMENT': encodePaymentHeader(payload) },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: 42 });
    const settlement = JSON.parse(
      Buffer.from(res.headers.get('X-PAYMENT-RESPONSE')!, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(settlement['transaction']).toBe(tx);
  });

  it('returns 402 with the facilitator reason when verification fails', async () => {
    const vendor = createRealVendor({
      facilitator: facilitatorStub({ verify: { isValid: false, invalidReason: 'insufficient_funds' } })
        .client,
      atomicPrice: '10000',
      payTo: PAY_TO,
    });

    const res = await vendor.fetch(URL_ANSWER, {
      headers: { 'X-PAYMENT': encodePaymentHeader(payload) },
    });

    expect(res.status).toBe(402);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('insufficient_funds');
  });

  it('returns 402 on a malformed X-PAYMENT header', async () => {
    const vendor = createRealVendor({
      facilitator: facilitatorStub({}).client,
      atomicPrice: '10000',
      payTo: PAY_TO,
    });

    const res = await vendor.fetch(URL_ANSWER, { headers: { 'X-PAYMENT': '%%garbage%%' } });
    expect(res.status).toBe(402);
  });
});

describe('createRealVendor on the x402 v2 wire', () => {
  it('dual mode quotes a byte-equivalent PAYMENT-REQUIRED header beside the v1 body', async () => {
    const vendor = createRealVendor({
      facilitator: facilitatorStub({}).client,
      atomicPrice: '10000',
      payTo: PAY_TO,
      advertise: 'dual',
    });

    const res = await vendor.fetch(URL_ANSWER);

    expect(res.status).toBe(402);
    const body = (await res.json()) as { x402Version: number; accepts: unknown[]; error: string };
    expect(body.x402Version).toBe(1);
    expect(body.accepts[0]).toEqual(vendor.requirementFor(URL_ANSWER));
    // The header is exactly the v2 rendering of the SAME quoted requirement.
    expect(res.headers.get('PAYMENT-REQUIRED')).toBe(
      encodeBase64Json(buildPaymentRequiredV2(vendor.requirementFor(URL_ANSWER), body.error)),
    );
  });

  it('strict v2 serves a guard with no v1 fallback, settlement only in PAYMENT-RESPONSE', async () => {
    const tx = `0x${'34'.repeat(32)}`;
    const stub = facilitatorStub({
      verify: { isValid: true },
      settle: { success: true, transaction: tx, network: 'base-sepolia' },
    });
    const vendor = createRealVendor({
      facilitator: stub.client,
      atomicPrice: '10000',
      payTo: PAY_TO,
      advertise: 'v2',
      body: { report: 7 },
    });

    // The unpaid 402's body is NOT x402 — the offer rides the header alone.
    const unpaid = await vendor.fetch(URL_ANSWER);
    expect(unpaid.status).toBe(402);
    expect(await unpaid.json()).toEqual({ error: 'payment is required' });
    expect(parsePaymentRequiredHeader(unpaid.headers.get('PAYMENT-REQUIRED'))).toBeDefined();

    const engine = new PolicyEngine();
    const app = buildServer(engine);
    await app.listen({ port: 0, host: '127.0.0.1' });
    try {
      const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      const wallet = generateWallet();
      const agent = await engine.registerAgent({
        id: newId('agt'),
        orgId: newId('org'),
        name: 'v2-vendor-test-agent',
        wallets: [{ chain: 'base', address: wallet.address, mode: 'sdk' }],
        status: 'active',
        createdAt: new Date(),
      });
      const guard = createGuard({
        engineUrl,
        agentId: agent.id,
        fetch: vendor.fetch,
        payer: createX402Payer({ privateKey: wallet.privateKey }),
      });
      await guard.client.addPolicy({
        policyId: 'pol_v2_allow',
        appliesTo: { agents: [agent.id] },
        default: 'allow',
      });

      const res = await guard.wrap()(URL_ANSWER);

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ report: 7 });
      // Settlement came back ONLY on the v2 header name, and the guard read it.
      expect(res.headers.get('X-PAYMENT-RESPONSE')).toBeNull();
      expect(res.headers.get('PAYMENT-RESPONSE')).not.toBeNull();
      expect(guard.receipts()[0]?.settlement?.txHash).toBe(tx);

      // The guard paid on PAYMENT-SIGNATURE with a rewrapped v2 envelope...
      const envelope = JSON.parse(
        Buffer.from(vendor.calls.at(-1)!.payment!, 'base64').toString('utf8'),
      ) as { x402Version: number; accepted: { network: string } };
      expect(envelope.x402Version).toBe(2);
      expect(envelope.accepted.network).toBe('eip155:84532');
      // ...and the facilitator saw that envelope with v2-shaped requirements.
      const verifyPost = stub.posts.find((p) => p.path === 'verify')!;
      expect(verifyPost.body['x402Version']).toBe(2);
      expect(verifyPost.body['paymentRequirements']).toMatchObject({
        amount: '10000',
        network: 'eip155:84532',
      });
    } finally {
      await app.close();
    }
  });

  it('accepts a v2 PAYMENT-SIGNATURE payment even while advertising v1', async () => {
    const tx = `0x${'56'.repeat(32)}`;
    const stub = facilitatorStub({
      verify: { isValid: true },
      settle: { success: true, transaction: tx, network: 'eip155:84532' },
    });
    const vendor = createRealVendor({
      facilitator: stub.client,
      atomicPrice: '10000',
      payTo: PAY_TO,
    });
    // A CAIP-2-named v2 envelope must satisfy the v1-named requirement.
    const header = wrapPaymentV2(encodePaymentHeader(payload), vendor.requirementFor(URL_ANSWER));

    const res = await vendor.fetch(URL_ANSWER, { headers: { 'PAYMENT-SIGNATURE': header } });

    expect(res.status).toBe(200);
    // Dual-set outside strict v2: both names carry the same settlement.
    expect(res.headers.get('X-PAYMENT-RESPONSE')).toBe(res.headers.get('PAYMENT-RESPONSE'));
    const settled = JSON.parse(
      Buffer.from(res.headers.get('PAYMENT-RESPONSE')!, 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(settled['transaction']).toBe(tx);
    // Requirements traveled in the payment's own dialect (amount + CAIP-2).
    expect(stub.posts.find((p) => p.path === 'settle')!.body['paymentRequirements']).toMatchObject({
      amount: '10000',
      network: 'eip155:84532',
    });
  });

  it('refuses a v2 payment for the wrong network, compared via CAIP-2', async () => {
    const stub = facilitatorStub({ verify: { isValid: true } });
    const vendor = createRealVendor({
      facilitator: stub.client,
      atomicPrice: '10000',
      payTo: PAY_TO,
    });
    const mainnet = encodeBase64Json({
      x402Version: 2,
      accepted: {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: '10000',
        asset: BASE_SEPOLIA_USDC,
        payTo: PAY_TO,
      },
      payload: payload.payload,
    });

    const res = await vendor.fetch(URL_ANSWER, { headers: { 'PAYMENT-SIGNATURE': mainnet } });

    expect(res.status).toBe(402);
    expect(stub.posts).toHaveLength(0); // refused before any facilitator round-trip
  });

  it('refuses a garbled v2 payment header cleanly, re-quoting in the same dialect', async () => {
    const vendor = createRealVendor({
      facilitator: facilitatorStub({}).client,
      atomicPrice: '10000',
      payTo: PAY_TO,
      advertise: 'v2',
    });

    const garbled = await vendor.fetch(URL_ANSWER, {
      headers: { 'PAYMENT-SIGNATURE': '%%garbage%%' },
    });
    expect(garbled.status).toBe(402);
    expect(parsePaymentRequiredHeader(garbled.headers.get('PAYMENT-REQUIRED'))).toBeDefined();

    // Self-contradictory envelope: accepted terms disagree with the signature.
    const contradictory = await vendor.fetch(URL_ANSWER, {
      headers: {
        'PAYMENT-SIGNATURE': encodeBase64Json({
          x402Version: 2,
          accepted: {
            scheme: 'exact',
            network: 'eip155:84532',
            amount: '999999',
            asset: BASE_SEPOLIA_USDC,
            payTo: PAY_TO,
          },
          payload: payload.payload,
        }),
      },
    });
    expect(contradictory.status).toBe(402);
    const body = (await contradictory.json()) as { error: string };
    expect(body.error).toContain('contradicts itself');
  });
});
