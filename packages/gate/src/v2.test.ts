import { describe, it, expect } from 'vitest';
import { PaymentRequired } from '@reinconsole/sdk';
import { createGate, type GateOptions, type GateOutcome } from './gate.js';
import { facilitatorClientRails, type GateRails } from './rails.js';
import { buildPaymentRequiredV2, caip2Of, sameNetwork, v2Requirements } from './v2.js';
import { inspectPaymentHeader } from './wire.js';

const VENDOR = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const WALLET = '0x857b06519E91e3A54538791bDbb0E22373e36b66';
const URL_ANSWER = 'https://api.vendor.test/api/answer';

/** A spec-shaped v2 PAYMENT-SIGNATURE envelope (exact-EVM). */
function v2Payment(overrides: {
  amount?: string;
  value?: string;
  network?: string;
  scheme?: string;
  to?: string;
  nonce?: string;
} = {}) {
  const amount = overrides.amount ?? '50000';
  return Buffer.from(
    JSON.stringify({
      x402Version: 2,
      resource: { url: URL_ANSWER, mimeType: 'application/json' },
      accepted: {
        scheme: overrides.scheme ?? 'exact',
        network: overrides.network ?? 'eip155:84532',
        amount,
        asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
        payTo: overrides.to ?? VENDOR,
        maxTimeoutSeconds: 300,
      },
      payload: {
        signature: '0x2d6a7588d6acca505cbf0d9a4a227e0c52c6c34008c8e8986a1283259764173608a2ce6496642e377d6da8dbbf5836e9bd15092f9ecab05ded3d6293af148b571c',
        authorization: {
          from: WALLET,
          to: overrides.to ?? VENDOR,
          value: overrides.value ?? amount,
          validAfter: '1740672089',
          validBefore: '1740672154',
          nonce: overrides.nonce ?? `0x${'f3'.repeat(32)}`,
        },
      },
      extensions: {},
    }),
  ).toString('base64');
}

function stubRails(overrides: Partial<GateRails> = {}): GateRails {
  return {
    async verify() {},
    async settle() {
      return { header: 'c2V0dGxlZA==', transaction: '0xtx', network: 'eip155:84532' };
    },
    ...overrides,
  };
}

function gateWith(options: Partial<GateOptions> = {}) {
  return createGate({
    routes: [{ path: '/api/answer', price: '0.05', description: 'one answer' }],
    rails: stubRails(),
    payTo: VENDOR,
    network: 'base-sepolia', // deliberately the v1 name — CAIP-2 payments must still match
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    retry: { attempts: 0, backoffMs: 0 },
    ...options,
  });
}

async function refusal(outcomePromise: Promise<GateOutcome>) {
  const outcome = await outcomePromise;
  if (outcome.kind !== 'refused') throw new Error(`expected refused, got ${outcome.kind}`);
  return outcome;
}

describe('CAIP-2 normalization', () => {
  it('maps known v1 names and passes unknown ids through lowercased', () => {
    expect(caip2Of('base-sepolia')).toBe('eip155:84532');
    expect(caip2Of('Base')).toBe('eip155:8453');
    expect(caip2Of('eip155:84532')).toBe('eip155:84532');
    expect(caip2Of('some-future-net')).toBe('some-future-net');
  });

  it('sameNetwork bridges the dialects without conflating chains', () => {
    expect(sameNetwork('base-sepolia', 'eip155:84532')).toBe(true);
    expect(sameNetwork('eip155:8453', 'base')).toBe(true);
    expect(sameNetwork('base', 'base-sepolia')).toBe(false);
    expect(sameNetwork('solana-devnet', 'eip155:84532')).toBe(false);
  });
});

describe('v2 wire builders', () => {
  const requirement = {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '50000',
    resource: URL_ANSWER,
    description: 'one answer',
    mimeType: 'application/json',
    payTo: VENDOR,
    maxTimeoutSeconds: 300,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  };

  it('renames maxAmountRequired to amount and upgrades the network to CAIP-2', () => {
    expect(v2Requirements(requirement)).toEqual({
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '50000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: VENDOR,
      maxTimeoutSeconds: 300,
    });
  });

  it('moves resource facts out of the requirement into ResourceInfo', () => {
    const required = buildPaymentRequiredV2(requirement, 'PAYMENT-SIGNATURE header is required');
    expect(required).toMatchObject({
      x402Version: 2,
      error: 'PAYMENT-SIGNATURE header is required',
      resource: { url: URL_ANSWER, description: 'one answer', mimeType: 'application/json' },
    });
    expect(required.accepts[0]).not.toHaveProperty('resource');
    expect(required.accepts[0]).not.toHaveProperty('maxAmountRequired');
  });
});

describe('inspectPaymentHeader — v2 envelopes', () => {
  it('extracts the same transfer facts from a v2 envelope', () => {
    const inspected = inspectPaymentHeader(v2Payment());
    expect(inspected).toMatchObject({
      version: 2,
      scheme: 'exact',
      network: 'eip155:84532',
      payer: WALLET,
      to: VENDOR,
      value: '50000',
    });
  });

  it('refuses a self-contradictory v2 envelope (accepted vs signed value)', () => {
    expect(() => inspectPaymentHeader(v2Payment({ amount: '50000', value: '49999' }))).toThrow(
      /contradicts itself/,
    );
  });

  it('refuses a v2 envelope missing accepted terms', () => {
    const header = Buffer.from(
      JSON.stringify({ x402Version: 2, payload: { from: WALLET, to: VENDOR, value: '1' } }),
    ).toString('base64');
    expect(() => inspectPaymentHeader(header)).toThrow(/invalid v2 payment envelope/);
  });
});

describe('Gate — v2 payments end to end', () => {
  it('settles a v2 payment against a v1-configured gate (CAIP-2 bridge)', async () => {
    const gate = gateWith();
    const outcome = await gate.handle({ method: 'GET', url: URL_ANSWER, payment: v2Payment() });
    if (outcome.kind !== 'paid') throw new Error(`expected paid, got ${outcome.kind}`);
    expect(outcome.receipt).toMatchObject({ payer: WALLET, amount: '0.05', amountAtomic: '50000' });
  });

  it('still refuses a v2 payment on the WRONG chain', async () => {
    const gate = gateWith();
    const outcome = await refusal(
      gate.handle({ method: 'GET', url: URL_ANSWER, payment: v2Payment({ network: 'eip155:8453' }) }),
    );
    expect(outcome.code).toBe('network_mismatch');
  });

  it('replay protection covers v2 headers too', async () => {
    const gate = gateWith();
    const header = v2Payment();
    expect((await gate.handle({ method: 'GET', url: URL_ANSWER, payment: header })).kind).toBe('paid');
    const replay = await refusal(gate.handle({ method: 'GET', url: URL_ANSWER, payment: header }));
    expect(replay.code).toBe('payment_replayed');
  });
});

describe('Gate — dual-stack quoting (advertiseV2)', () => {
  it('quotes BOTH dialects: v1 body unchanged, v2 in paymentRequiredHeader', async () => {
    const gate = gateWith({ advertiseV2: true });
    const outcome = await gate.handle({ method: 'GET', url: URL_ANSWER, payment: null });
    if (outcome.kind !== 'quote') throw new Error(`expected quote, got ${outcome.kind}`);

    // v1 clients parse the body exactly as before.
    const v1 = PaymentRequired.parse(outcome.body);
    expect(v1.accepts[0]).toMatchObject({ maxAmountRequired: '50000', network: 'base-sepolia' });

    // v2 clients decode the PAYMENT-REQUIRED header.
    expect(outcome.paymentRequiredHeader).toBeTruthy();
    const v2 = JSON.parse(Buffer.from(outcome.paymentRequiredHeader!, 'base64').toString('utf8'));
    expect(v2).toMatchObject({ x402Version: 2, resource: { url: URL_ANSWER } });
    expect(v2.accepts[0]).toMatchObject({ amount: '50000', network: 'eip155:84532' });
  });

  it('402 re-quote refusals carry the v2 header as well; without the flag nothing does', async () => {
    const advertised = gateWith({ advertiseV2: true });
    const refused = await refusal(
      advertised.handle({ method: 'GET', url: URL_ANSWER, payment: v2Payment({ amount: '1', value: '1' }) }),
    );
    expect(refused.code).toBe('amount_mismatch');
    expect(refused.paymentRequiredHeader).toBeTruthy();

    const plain = gateWith();
    const quote = await plain.handle({ method: 'GET', url: URL_ANSWER, payment: null });
    if (quote.kind !== 'quote') throw new Error('expected quote');
    expect(quote.paymentRequiredHeader).toBeUndefined();
  });
});

describe('facilitatorClientRails — dialect-matched requirements', () => {
  function capturingClient() {
    const calls: { path: 'verify' | 'settle'; requirements: unknown; payloadVersion: unknown }[] = [];
    return {
      calls,
      async verify(payload: unknown, requirements: unknown) {
        calls.push({
          path: 'verify',
          requirements,
          payloadVersion: (payload as { x402Version?: unknown }).x402Version,
        });
        return { isValid: true };
      },
      async settle(payload: unknown, requirements: unknown) {
        calls.push({
          path: 'settle',
          requirements,
          payloadVersion: (payload as { x402Version?: unknown }).x402Version,
        });
        return { success: true, transaction: '0xtx', network: 'eip155:84532' };
      },
    };
  }

  it('a v2 payment travels with v2-shaped requirements; a v1 payment with v1', async () => {
    const client = capturingClient();
    const gate = gateWith({ rails: facilitatorClientRails(client) });

    expect((await gate.handle({ method: 'GET', url: URL_ANSWER, payment: v2Payment() })).kind).toBe(
      'paid',
    );
    expect(client.calls.map((c) => c.payloadVersion)).toEqual([2, 2]);
    for (const call of client.calls) {
      expect(call.requirements).toMatchObject({ amount: '50000', network: 'eip155:84532' });
      expect(call.requirements).not.toHaveProperty('maxAmountRequired');
    }

    client.calls.length = 0;
    const v1Header = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base-sepolia',
        payload: { from: WALLET, to: VENDOR, value: '50000', asset: 'USDC' },
      }),
    ).toString('base64');
    expect((await gate.handle({ method: 'GET', url: URL_ANSWER, payment: v1Header })).kind).toBe(
      'paid',
    );
    expect(client.calls.map((c) => c.payloadVersion)).toEqual([1, 1]);
    for (const call of client.calls) {
      expect(call.requirements).toMatchObject({ maxAmountRequired: '50000', network: 'base-sepolia' });
    }
  });
});
