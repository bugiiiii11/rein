import { describe, it, expect } from 'vitest';
import { MockFacilitator, MockLedger } from '@rein/mock-rails';
import { PaymentRequired } from '@rein/sdk';
import { createGatedFetch } from './fetch.js';
import { createGate } from './gate.js';
import { mockFacilitatorRails } from './rails.js';

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
