import { describe, it, expect } from 'vitest';
import { RailsError } from './errors.js';
import {
  decodePaymentHeader,
  encodePaymentHeader,
  encodeSettlementHeader,
  type PaymentPayload,
  type SettleResponse,
} from './wire.js';

const payload: PaymentPayload = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base-sepolia',
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '10000',
      validAfter: '1749999400',
      validBefore: '1750000300',
      nonce: `0x${'cd'.repeat(32)}`,
    },
  },
};

describe('X-PAYMENT codec', () => {
  it('roundtrips a payment payload through base64', () => {
    expect(decodePaymentHeader(encodePaymentHeader(payload))).toEqual(payload);
  });

  it('rejects non-base64 garbage with malformed_payment', () => {
    expect(() => decodePaymentHeader('%%not-base64%%')).toThrowError(RailsError);
  });

  it('rejects schema violations (float value, short nonce, bad address)', () => {
    const bad = (mutate: (p: typeof payload) => void) => {
      const copy = structuredClone(payload);
      mutate(copy);
      return Buffer.from(JSON.stringify(copy)).toString('base64');
    };
    expect(() =>
      decodePaymentHeader(bad((p) => (p.payload.authorization.value = '0.01'))),
    ).toThrowError(RailsError);
    expect(() =>
      decodePaymentHeader(bad((p) => (p.payload.authorization.nonce = '0x1234'))),
    ).toThrowError(RailsError);
    expect(() =>
      decodePaymentHeader(bad((p) => (p.payload.authorization.from = 'not-an-address'))),
    ).toThrowError(RailsError);
  });
});

describe('X-PAYMENT-RESPONSE codec', () => {
  it('encodes a settlement the guard can parse (base64 JSON with transaction/network)', () => {
    const settled: SettleResponse = {
      success: true,
      transaction: `0x${'12'.repeat(32)}`,
      network: 'base-sepolia',
      payer: '0x1111111111111111111111111111111111111111',
    };
    const decoded = JSON.parse(
      Buffer.from(encodeSettlementHeader(settled), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(decoded['transaction']).toBe(settled.transaction);
    expect(decoded['network']).toBe('base-sepolia');
  });
});
