import { describe, it, expect } from 'vitest';
import { PaymentRequirement } from './x402.js';
import {
  buildPaymentRequiredV2,
  caip2Of,
  encodeBase64Json,
  parsePaymentRequiredHeader,
  requirementFromV2,
  sameNetwork,
  v2Requirements,
  wrapPaymentV2,
} from './x402v2.js';

const requirement = (overrides: Partial<PaymentRequirement> = {}): PaymentRequirement =>
  PaymentRequirement.parse({
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    resource: 'https://api.vendor.test/v1/answer',
    description: 'the answer',
    mimeType: 'application/json',
    payTo: '0xVENDOR',
    maxTimeoutSeconds: 300,
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    extra: { name: 'USDC', version: '2' },
    ...overrides,
  });

describe('CAIP-2 normalization', () => {
  it('maps v1 names, passes CAIP-2 ids and unknowns through lowercased', () => {
    expect(caip2Of('base-sepolia')).toBe('eip155:84532');
    expect(caip2Of('eip155:84532')).toBe('eip155:84532');
    expect(caip2Of('SomethingElse')).toBe('somethingelse');
  });

  it('sameNetwork compares across the dialect divide', () => {
    expect(sameNetwork('base', 'eip155:8453')).toBe(true);
    expect(sameNetwork('eip155:84532', 'base')).toBe(false);
  });
});

describe('requirement dialect conversion', () => {
  it('v2Requirements renames amount and normalizes the network', () => {
    expect(v2Requirements(requirement())).toEqual({
      scheme: 'exact',
      network: 'eip155:84532',
      amount: '10000',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      payTo: '0xVENDOR',
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    });
  });

  it('requirementFromV2 restores the internal shape, resource included', () => {
    const original = requirement();
    const roundTripped = requirementFromV2(v2Requirements(original), {
      url: original.resource!,
      description: original.description!,
      mimeType: original.mimeType!,
    });
    // The network comes back CAIP-2 — everything downstream resolves both.
    expect(roundTripped).toEqual({ ...original, network: 'eip155:84532' });
  });
});

describe('PAYMENT-REQUIRED parsing', () => {
  it('decodes what buildPaymentRequiredV2 encodes', () => {
    const built = buildPaymentRequiredV2(requirement(), 'payment is required');
    const parsed = parsePaymentRequiredHeader(encodeBase64Json(built));
    expect(parsed).toEqual(built);
    expect(parsed?.resource?.url).toBe('https://api.vendor.test/v1/answer');
  });

  it('is lenient: missing, garbled, or non-v2 headers all yield undefined', () => {
    expect(parsePaymentRequiredHeader(null)).toBeUndefined();
    expect(parsePaymentRequiredHeader('%%not-base64%%')).toBeUndefined();
    expect(
      parsePaymentRequiredHeader(encodeBase64Json({ x402Version: 1, accepts: [] })),
    ).toBeUndefined();
  });
});

describe('wrapPaymentV2', () => {
  const v1Header = encodeBase64Json({
    x402Version: 1,
    scheme: 'exact',
    network: 'base-sepolia',
    payload: { from: '0xAGENT', to: '0xVENDOR', value: '10000', intentId: 'int_1' },
  });

  it('rewraps a v1 envelope: same payload, requirement as accepted', () => {
    const wrapped = wrapPaymentV2(v1Header, requirement(), {
      url: 'https://api.vendor.test/v1/answer',
    });
    const envelope = JSON.parse(Buffer.from(wrapped, 'base64').toString('utf8'));
    expect(envelope).toEqual({
      x402Version: 2,
      resource: { url: 'https://api.vendor.test/v1/answer' },
      accepted: v2Requirements(requirement()),
      payload: { from: '0xAGENT', to: '0xVENDOR', value: '10000', intentId: 'int_1' },
      extensions: {},
    });
  });

  it('passes an already-v2 envelope through unchanged', () => {
    const already = encodeBase64Json({ x402Version: 2, accepted: {}, payload: {} });
    expect(wrapPaymentV2(already, requirement())).toBe(already);
  });

  it('throws on a header no dialect recognizes — a payer bug, not wire input', () => {
    expect(() => wrapPaymentV2('mock-payment-header', requirement())).toThrowError(TypeError);
  });
});
