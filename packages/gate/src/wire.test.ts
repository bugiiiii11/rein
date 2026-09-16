import { describe, it, expect } from 'vitest';
import { GateError } from './errors.js';
import { MAX_PAYMENT_HEADER_CHARS, inspectPaymentHeader } from './wire.js';

const encode = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64');

describe('inspectPaymentHeader', () => {
  it('reads the transfer facts from a real exact-EVM payload (nested authorization)', () => {
    const header = encode({
      x402Version: 1,
      scheme: 'exact',
      network: 'base-sepolia',
      payload: {
        signature: '0xdeadbeef',
        authorization: {
          from: '0x4b64d60ee40a9bf3108c5c09cc25AFC9a971958F',
          to: '0xE239D0281fc9B524DCBdA81Ffd89F4f5bed1383E',
          value: '10000',
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x' + '11'.repeat(32),
        },
      },
    });
    const inspected = inspectPaymentHeader(header);
    expect(inspected).toMatchObject({
      scheme: 'exact',
      network: 'base-sepolia',
      payer: '0x4b64d60ee40a9bf3108c5c09cc25AFC9a971958F',
      to: '0xE239D0281fc9B524DCBdA81Ffd89F4f5bed1383E',
      value: '10000',
    });
  });

  it('reads the transfer facts from a mock flat payload', () => {
    const header = encode({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from: '0xAgent', to: '0xVENDOR', value: '50000', asset: 'USDC' },
    });
    const inspected = inspectPaymentHeader(header);
    expect(inspected).toMatchObject({ payer: '0xAgent', to: '0xVENDOR', value: '50000' });
  });

  it('keeps the decoded envelope verbatim for rails that re-verify it', () => {
    const body = {
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from: 'a', to: 'b', value: '1', intentId: 'int_x' },
    };
    expect(inspectPaymentHeader(encode(body)).envelope).toEqual(body);
  });

  it('rejects non-base64-JSON headers as malformed_payment', () => {
    try {
      inspectPaymentHeader('not base64 at all!!!');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GateError);
      expect((err as GateError).code).toBe('malformed_payment');
    }
  });

  it('rejects unknown envelope versions and missing transfers', () => {
    const v2 = encode({ x402Version: 2, scheme: 'exact', network: 'base', payload: {} });
    expect(() => inspectPaymentHeader(v2)).toThrowError(GateError);
    const noTransfer = encode({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from: '0xAgent', value: 'not-a-number' },
    });
    expect(() => inspectPaymentHeader(noTransfer)).toThrowError(GateError);
  });
});

describe('the payment header cap', () => {
  it('refuses an oversized header as malformed_payment before decoding it', () => {
    // One character over: the cap is exact, and it fires before Buffer.from
    // would allocate anything for what is, at any size, still not a payment.
    const oversized = 'A'.repeat(MAX_PAYMENT_HEADER_CHARS + 1);
    try {
      inspectPaymentHeader(oversized);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(GateError);
      expect((err as GateError).code).toBe('malformed_payment');
      expect((err as GateError).message).toMatch(/at most 16384/);
    }
  });

  it('is a cap on size, not on shape: a header exactly at the limit is still decoded', () => {
    // Pad a valid envelope with an ignored field up to exactly the cap; the
    // envelope must parse, so the refusal above is about length alone.
    const body = {
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from: '0xAgent', to: '0xVENDOR', value: '50000', asset: 'USDC' },
      padding: '',
    };
    const base = encode(body).length;
    // base64 grows 4 chars per 3 bytes; pad in 3-byte steps to land on the cap.
    body.padding = 'x'.repeat(Math.floor(((MAX_PAYMENT_HEADER_CHARS - base) / 4) * 3));
    const header = encode(body);
    expect(header.length).toBeLessThanOrEqual(MAX_PAYMENT_HEADER_CHARS);
    expect(header.length).toBeGreaterThan(MAX_PAYMENT_HEADER_CHARS - 8);
    expect(inspectPaymentHeader(header)).toMatchObject({ payer: '0xAgent', value: '50000' });
  });
});
