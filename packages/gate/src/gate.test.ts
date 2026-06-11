import { describe, it, expect } from 'vitest';
import { GateReceipt, type ReinEvent } from '@rein/core';
import { PaymentRequired } from '@rein/sdk';
import { createGate, type GateOptions, type GateOutcome } from './gate.js';
import type { GateRails } from './rails.js';

const VENDOR = '0xVENDOR';
const WALLET = '0xAgentWallet01';
const URL_ANSWER = 'https://api.vendor.test/api/answer';

/** A rails stub that always verifies and settles (overridable per test). */
function stubRails(overrides: Partial<GateRails> = {}): GateRails & { settles: number } {
  const rails: GateRails & { settles: number } = {
    settles: 0,
    async verify() {},
    async settle() {
      rails.settles += 1;
      return { header: 'c2V0dGxlZA==', transaction: `0xtx${rails.settles}`, network: 'base' };
    },
    ...overrides,
  };
  return rails;
}

/** A mock-shape X-PAYMENT header; vary `intentId` to get distinct payments. */
function payment(overrides: Record<string, unknown> = {}, envelope: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      ...envelope,
      payload: { from: WALLET, to: VENDOR, value: '50000', asset: 'USDC', ...overrides },
    }),
  ).toString('base64');
}

function gateWith(options: Partial<GateOptions> = {}) {
  const events: ReinEvent[] = [];
  const gate = createGate({
    routes: [
      { path: '/api/premium/*', method: 'POST', price: '0.25' },
      { path: '/api/answer', price: '0.05' },
    ],
    rails: stubRails(),
    payTo: VENDOR,
    network: 'base',
    asset: 'USDC',
    ...options,
  });
  gate.onEvent((e) => events.push(e));
  return { gate, events };
}

async function refusal(outcomePromise: Promise<GateOutcome>) {
  const outcome = await outcomePromise;
  if (outcome.kind !== 'refused') throw new Error(`expected refused, got ${outcome.kind}`);
  return outcome;
}

describe('Gate.handle', () => {
  it('passes unpriced routes through untouched', async () => {
    const { gate, events } = gateWith();
    const outcome = await gate.handle({
      method: 'GET',
      url: 'https://api.vendor.test/health',
      payment: null,
    });
    expect(outcome).toEqual({ kind: 'open' });
    expect(events).toHaveLength(0);
  });

  it('quotes a spec-valid 402 for a priced route and emits gate.quoted', async () => {
    const { gate, events } = gateWith();
    const outcome = await gate.handle({ method: 'GET', url: URL_ANSWER, payment: null });
    if (outcome.kind !== 'quote') throw new Error(`expected quote, got ${outcome.kind}`);
    expect(outcome.status).toBe(402);
    const body = PaymentRequired.parse(outcome.body);
    expect(body.accepts[0]).toMatchObject({
      scheme: 'exact',
      maxAmountRequired: '50000',
      payTo: VENDOR,
      resource: URL_ANSWER,
    });
    expect(events[0]).toMatchObject({
      type: 'gate.quoted',
      resource: '/api/answer',
      method: 'GET',
      amount: '0.05',
      asset: 'USDC',
    });
  });

  it('settles a matching payment: receipt, settlement header, gate.settled', async () => {
    const { gate, events } = gateWith();
    const outcome = await gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment() });
    if (outcome.kind !== 'paid') throw new Error(`expected paid, got ${outcome.kind}`);
    expect(outcome.settlementHeader).toBe('c2V0dGxlZA==');
    expect(GateReceipt.parse(outcome.receipt)).toMatchObject({
      route: '/api/answer',
      resource: '/api/answer',
      method: 'GET',
      payer: WALLET,
      payTo: VENDOR,
      amount: '0.05',
      amountAtomic: '50000',
      asset: 'USDC',
      network: 'base',
      transaction: '0xtx1',
    });
    expect(gate.receipts).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'gate.settled' });
  });

  it('refuses payments that do not match the quote (the consistency matrix)', async () => {
    const { gate } = gateWith();
    const cases: [string, string][] = [
      [payment({}, { scheme: 'lightning' }), 'scheme_mismatch'],
      [payment({}, { network: 'base-sepolia' }), 'network_mismatch'],
      [payment({ value: '49999' }), 'amount_mismatch'],
      [payment({ to: '0xSomeoneElse' }), 'recipient_mismatch'],
      ['garbage!!!', 'malformed_payment'],
    ];
    for (const [header, code] of cases) {
      const outcome = await refusal(
        gate.handle({ method: 'GET', url: URL_ANSWER, payment: header }),
      );
      expect(outcome.code).toBe(code);
      expect(outcome.status).toBe(402);
      // Payment problems re-quote: the body must still carry a valid offer.
      expect(PaymentRequired.parse(outcome.body).accepts).toHaveLength(1);
    }
    expect(gate.stats().refused).toBe(cases.length);
    expect(gate.stats().settled).toBe(0);
  });

  it('compares the recipient case-insensitively (EVM rule)', async () => {
    const { gate } = gateWith();
    const outcome = await gate.handle({
      method: 'GET',
      url: URL_ANSWER,
      payment: payment({ to: VENDOR.toLowerCase() }),
    });
    expect(outcome.kind).toBe('paid');
  });

  it('denylisted payers get a 403 before any rails round-trip', async () => {
    const rails = stubRails({
      async verify() {
        throw new Error('rails must not be reached');
      },
    });
    const { gate, events } = gateWith({ rails, screen: { denyPayers: [WALLET.toUpperCase()] } });
    const outcome = await refusal(gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment() }));
    expect(outcome).toMatchObject({ status: 403, code: 'payer_denied' });
    expect(outcome.body).toMatchObject({ error: 'refused', code: 'payer_denied' });
    expect(events[0]).toMatchObject({ type: 'gate.refused', payer: WALLET });
  });

  it('an allowlist refuses everyone not on it', async () => {
    const { gate } = gateWith({ screen: { allowPayers: ['0xSomeoneElse'] } });
    const outcome = await refusal(gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment() }));
    expect(outcome).toMatchObject({ status: 403, code: 'payer_not_allowed' });

    const { gate: openGate } = gateWith({ screen: { allowPayers: [WALLET.toLowerCase()] } });
    const allowed = await openGate.handle({ method: 'GET', url: URL_ANSWER, payment: payment() });
    expect(allowed.kind).toBe('paid');
  });

  it('a dynamic screen.check refusal is a 403 payer_denied with the returned reason', async () => {
    const seen: string[] = [];
    const { gate, events } = gateWith({
      rails: stubRails({
        async verify() {
          throw new Error('rails must not be reached');
        },
      }),
      screen: {
        check: (payer) => {
          seen.push(payer);
          return 'payer reputation 12 is below this gate\'s floor of 40';
        },
      },
    });
    const outcome = await refusal(gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment() }));
    expect(outcome).toMatchObject({ status: 403, code: 'payer_denied' });
    expect(outcome.reason).toMatch(/below this gate's floor/);
    expect(seen).toEqual([WALLET]); // called with the payer as presented
    expect(events[0]).toMatchObject({ type: 'gate.refused', code: 'payer_denied', payer: WALLET });
  });

  it('a screen.check returning undefined lets the payment through, after the lists', async () => {
    const { gate } = gateWith({ screen: { check: () => undefined } });
    const outcome = await gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment() });
    expect(outcome.kind).toBe('paid');

    // Static lists fire first: a denylisted payer never reaches the hook.
    let reached = false;
    const { gate: listed } = gateWith({
      screen: {
        denyPayers: [WALLET],
        check: () => {
          reached = true;
          return undefined;
        },
      },
    });
    const refusedOutcome = await refusal(
      listed.handle({ method: 'GET', url: URL_ANSWER, payment: payment() }),
    );
    expect(refusedOutcome.code).toBe('payer_denied');
    expect(reached).toBe(false);
  });

  it('refuses the exact same payment twice (replay)', async () => {
    const rails = stubRails();
    const { gate } = gateWith({ rails });
    const header = payment({ intentId: 'int_once' });
    const first = await gate.handle({ method: 'GET', url: URL_ANSWER, payment: header });
    expect(first.kind).toBe('paid');
    const second = await refusal(gate.handle({ method: 'GET', url: URL_ANSWER, payment: header }));
    expect(second.code).toBe('payment_replayed');
    expect(rails.settles).toBe(1);
  });

  it('two CONCURRENT copies of one payment cannot both settle (burn-first)', async () => {
    const rails = stubRails({
      async verify() {
        await new Promise((resolve) => setTimeout(resolve, 5));
      },
    });
    const { gate } = gateWith({ rails });
    const header = payment({ intentId: 'int_race' });
    const request = { method: 'GET', url: URL_ANSWER, payment: header };
    const [a, b] = await Promise.all([gate.handle(request), gate.handle(request)]);
    expect([a.kind, b.kind].sort()).toEqual(['paid', 'refused']);
    expect(rails.settles).toBe(1);
  });

  it('relays rails verify/settle refusals with their reasons', async () => {
    const { GateError } = await import('./errors.js');
    const badSig = gateWith({
      rails: stubRails({
        async verify() {
          throw new GateError('verify_failed', 'invalid signature');
        },
      }),
    });
    const verifyOutcome = await refusal(
      badSig.gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment() }),
    );
    expect(verifyOutcome).toMatchObject({ code: 'verify_failed', reason: 'invalid signature' });

    const broke = gateWith({
      rails: stubRails({
        async settle() {
          throw new GateError('settle_failed', 'facilitator rejected the authorization');
        },
      }),
    });
    const settleOutcome = await refusal(
      broke.gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment() }),
    );
    expect(settleOutcome.code).toBe('settle_failed');
  });

  it('does NOT swallow unexpected rails errors as refusals', async () => {
    const { gate } = gateWith({
      rails: stubRails({
        async verify() {
          throw new TypeError('rails bug');
        },
      }),
    });
    await expect(
      gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment() }),
    ).rejects.toThrow('rails bug');
  });

  it('aggregates revenue by asset, route, and payer in stats()', async () => {
    const { gate } = gateWith();
    await gate.handle({ method: 'GET', url: URL_ANSWER, payment: null }); // quote
    await gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment({ intentId: 'a' }) });
    await gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment({ intentId: 'b' }) });
    await gate.handle({
      method: 'POST',
      url: 'https://api.vendor.test/api/premium/forecast',
      payment: payment({ intentId: 'c', value: '250000' }),
    });
    await refusal(gate.handle({ method: 'GET', url: URL_ANSWER, payment: payment({ value: '1' }) }));

    expect(gate.stats()).toEqual({
      quoted: 1,
      settled: 3,
      refused: 1,
      revenue: { USDC: '0.35' },
      routes: {
        '/api/answer': { settled: 2, revenue: '0.1' },
        '/api/premium/*': { settled: 1, revenue: '0.25' },
      },
      payers: { [WALLET.toLowerCase()]: { settled: 3, revenue: '0.35' } },
    });
  });
});
