import { describe, it, expect } from 'vitest';
import { GateError } from './errors.js';
import { inspectPaymentHeader } from './wire.js';

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
