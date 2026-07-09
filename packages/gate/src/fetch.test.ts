import { describe, it, expect } from 'vitest';
import { MockFacilitator, MockLedger } from '@reinconsole/mock-rails';
import { PaymentRequired } from '@reinconsole/sdk';
import { createGatedFetch } from './fetch.js';
import { createGate } from './gate.js';
import { facilitatorClientRails, mockFacilitatorRails } from './rails.js';

const VENDOR = '0xVENDOR';
const WALLET = '0xAgentWallet01';
const URL_ANSWER = 'https://api.vendor.test/api/answer';

function world() {
  const ledger = new MockLedger();
  const facilitator = new MockFacilitator({ ledger });
  const gate = createGate({
    routes: [{ path: '/api/answer', price: '0.05' }],
    rails: mockFacilitatorRails(facilitator),
    payTo: VENDOR,
    network: 'base',
    asset: 'USDC',
  });
  const vendorFetch = createGatedFetch(gate, {
    serve: () => new Response(JSON.stringify({ answer: 42 }), { status: 200 }),
  });
  return { ledger, gate, vendorFetch };
}

const header = () =>
  Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from: WALLET, to: VENDOR, value: '50000', asset: 'USDC', intentId: 'int_f' },
    }),
  ).toString('base64');

describe('createGatedFetch', () => {
  it('behaves like the mock/real vendors: 402 quote, then serve on payment', async () => {
    const { ledger, vendorFetch } = world();

    const quoted = await vendorFetch(URL_ANSWER);
    expect(quoted.status).toBe(402);
    expect(PaymentRequired.parse(await quoted.json()).accepts).toHaveLength(1);

    const paid = await vendorFetch(URL_ANSWER, { headers: { 'X-PAYMENT': header() } });
    expect(paid.status).toBe(200);
    expect(await paid.json()).toEqual({ answer: 42 });
    expect(paid.headers.get('X-PAYMENT-RESPONSE')).toBeTruthy();
    expect(ledger.entries()).toHaveLength(1);
  });

  it('serves unpriced routes without touching the rails', async () => {
    const { ledger, vendorFetch } = world();
    const res = await vendorFetch('https://api.vendor.test/health');
    expect(res.status).toBe(200);
    expect(ledger.entries()).toHaveLength(0);
  });

  it('relays gate refusals as JSON error responses', async () => {
    const { vendorFetch } = world();
    await vendorFetch(URL_ANSWER, { headers: { 'X-PAYMENT': header() } });
    const replayed = await vendorFetch(URL_ANSWER, { headers: { 'X-PAYMENT': header() } });
    expect(replayed.status).toBe(402);
    const body = PaymentRequired.parse(await replayed.json());
    expect(body.error).toMatch(/already presented/);
  });
});

/** A consistent v2 PaymentPayload envelope for the priced route. */
const headerV2 = (value = '50000') =>
  Buffer.from(
    JSON.stringify({
      x402Version: 2,
      accepted: {
        scheme: 'exact',
        network: 'eip155:8453',
        amount: value,
        asset: 'USDC',
        payTo: VENDOR,
      },
      payload: { from: WALLET, to: VENDOR, value, asset: 'USDC', intentId: 'int_v2' },
    }),
  ).toString('base64');

const decodeHeader = (raw: string) =>
  JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) as Record<string, unknown>;

describe('createGatedFetch on the v2 wire', () => {
  it('settles a PAYMENT-SIGNATURE payment through the mock rails', async () => {
    const { ledger, vendorFetch } = world();

    const paid = await vendorFetch(URL_ANSWER, { headers: { 'PAYMENT-SIGNATURE': headerV2() } });

    expect(paid.status).toBe(200);
    expect(paid.headers.get('PAYMENT-RESPONSE')).toBeTruthy();
    expect(ledger.entries()[0]).toMatchObject({ from: WALLET, to: VENDOR, amount: '0.05' });
  });

  it('relays the rails\' own failed settlement in PAYMENT-RESPONSE', async () => {
    const failed = {
      success: false,
      errorReason: 'insufficient_funds',
      payer: WALLET,
      transaction: '',
      network: 'eip155:8453',
    };
    const gate = createGate({
      routes: [{ path: '/api/answer', price: '0.05' }],
      rails: facilitatorClientRails({
        verify: async () => ({ isValid: true }),
        settle: async () => ({ ...failed }),
      }),
      payTo: VENDOR,
      network: 'base',
      asset: 'USDC',
    });
    const vendorFetch = createGatedFetch(gate);

    const res = await vendorFetch(URL_ANSWER, { headers: { 'PAYMENT-SIGNATURE': headerV2() } });

    expect(res.status).toBe(402);
    // Verbatim relay: the payer reads the facilitator's real errorReason.
    expect(decodeHeader(res.headers.get('PAYMENT-RESPONSE')!)).toEqual(failed);
  });

  it('synthesizes a failed settlement for gate-local v2 refusals', async () => {
    const { vendorFetch } = world();

    const res = await vendorFetch(URL_ANSWER, {
      headers: { 'PAYMENT-SIGNATURE': headerV2('40000') }, // consistent, but under-quotes
    });

    expect(res.status).toBe(402);
    expect(decodeHeader(res.headers.get('PAYMENT-RESPONSE')!)).toEqual({
      success: false,
      errorReason: 'amount_mismatch',
      transaction: '',
      network: 'eip155:8453',
      payer: WALLET,
    });
  });

  it('v1 refusals carry no PAYMENT-RESPONSE — the verdict lives in the body', async () => {
    const { vendorFetch } = world();
    await vendorFetch(URL_ANSWER, { headers: { 'X-PAYMENT': header() } });
    const replayed = await vendorFetch(URL_ANSWER, { headers: { 'X-PAYMENT': header() } });

    expect(replayed.status).toBe(402);
    expect(replayed.headers.get('PAYMENT-RESPONSE')).toBeNull();
  });
});
