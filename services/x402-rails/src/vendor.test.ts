import { describe, it, expect } from 'vitest';
import { PaymentRequired, type FetchLike } from '@rein/sdk';
import { FacilitatorClient } from './facilitator.js';
import { createRealVendor } from './vendor.js';
import { BASE_SEPOLIA_USDC } from './wallet.js';
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

function facilitatorStub(responses: Record<string, unknown>): FacilitatorClient {
  const fetch: FetchLike = (input) => {
    const path = new URL(String(input)).pathname.split('/').at(-1) ?? '';
    const body = responses[path];
    if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
  };
  return new FacilitatorClient({ url: 'https://fac.test', fetch });
}

describe('createRealVendor', () => {
  it('quotes a 402 the SDK parses and the hosted facilitator accepts', async () => {
    const vendor = createRealVendor({
      facilitator: facilitatorStub({}),
      atomicPrice: '10000',
      payTo: PAY_TO,
    });

    const res = await vendor.fetch(URL_ANSWER);
    expect(res.status).toBe(402);

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
      }),
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
      facilitator: facilitatorStub({ verify: { isValid: false, invalidReason: 'insufficient_funds' } }),
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
      facilitator: facilitatorStub({}),
      atomicPrice: '10000',
      payTo: PAY_TO,
    });

    const res = await vendor.fetch(URL_ANSWER, { headers: { 'X-PAYMENT': '%%garbage%%' } });
    expect(res.status).toBe(402);
  });
});
