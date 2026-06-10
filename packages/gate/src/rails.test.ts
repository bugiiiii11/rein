import { describe, it, expect } from 'vitest';
import { MockFacilitator, MockLedger } from '@rein/mock-rails';
import { FacilitatorClient } from '@rein/x402-rails';
import type { PaymentRequirement } from '@rein/sdk';
import { GateError } from './errors.js';
import { facilitatorClientRails, mockFacilitatorRails } from './rails.js';

const VENDOR = '0xVENDOR';
const WALLET = '0xAgentWallet01';

const requirement: PaymentRequirement = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '50000',
  payTo: VENDOR,
  asset: 'USDC',
};

const encode = (body: unknown) => Buffer.from(JSON.stringify(body)).toString('base64');
const decode = (header: string) => JSON.parse(Buffer.from(header, 'base64').toString('utf8'));

/** A mock-rails payment header, exactly as MockFacilitator.payerFor builds it. */
const mockHeader = (value = '50000') =>
  encode({
    x402Version: 1,
    scheme: 'exact',
    network: 'base',
    payload: { from: WALLET, to: VENDOR, value, asset: 'USDC', intentId: 'int_test' },
  });

describe('mockFacilitatorRails', () => {
  it('verifies and settles through the real MockFacilitator onto the ledger', async () => {
    const ledger = new MockLedger();
    const rails = mockFacilitatorRails(new MockFacilitator({ ledger }));

    await expect(rails.verify(mockHeader(), requirement)).resolves.toBeUndefined();
    const settlement = await rails.settle(mockHeader(), requirement);

    const entry = ledger.entries()[0];
    expect(entry).toMatchObject({ from: WALLET, to: VENDOR, amount: '0.05', memo: 'int_test' });
    expect(settlement.transaction).toBe(entry?.txHash);
    expect(decode(settlement.header)).toMatchObject({ success: true, payer: WALLET });
  });

  it('maps facilitator rejections to verify_failed / settle_failed', async () => {
    const rails = mockFacilitatorRails(new MockFacilitator({ ledger: new MockLedger() }));
    const short = { ...requirement, maxAmountRequired: '99999' };
    await expect(rails.verify(mockHeader(), short)).rejects.toMatchObject({
      code: 'verify_failed',
    });
    await expect(rails.settle(mockHeader(), short)).rejects.toMatchObject({
      code: 'settle_failed',
    });
  });
});

describe('facilitatorClientRails', () => {
  /** A real exact-EVM header (signature checked by the facilitator, not us). */
  const evmHeader = encode({
    x402Version: 1,
    scheme: 'exact',
    network: 'base-sepolia',
    payload: {
      signature: '0x' + 'ab'.repeat(65),
      authorization: {
        from: WALLET,
        to: VENDOR,
        value: '10000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x' + '11'.repeat(32),
      },
    },
  });

  function clientWith(responses: { verify?: unknown; settle?: unknown }) {
    const calls: { url: string; body: unknown }[] = [];
    const client = new FacilitatorClient({
      url: 'https://fac.test',
      fetch: async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
        const body = url.endsWith('/verify') ? responses.verify : responses.settle;
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    return { rails: facilitatorClientRails(client), calls };
  }

  it('posts the decoded v1 envelope and relays the settlement verbatim', async () => {
    const settle = { success: true, transaction: '0xabc123', network: 'base-sepolia', payer: WALLET };
    const { rails, calls } = clientWith({ verify: { isValid: true }, settle });

    await rails.verify(evmHeader, requirement);
    expect(calls[0]?.url).toBe('https://fac.test/verify');
    expect(calls[0]?.body).toEqual({
      x402Version: 1,
      paymentPayload: decode(evmHeader),
      paymentRequirements: requirement,
    });

    const settlement = await rails.settle(evmHeader, requirement);
    expect(settlement).toMatchObject({ transaction: '0xabc123', network: 'base-sepolia' });
    expect(decode(settlement.header)).toEqual(settle);
  });

  it('maps facilitator refusals to verify_failed / settle_failed with reasons', async () => {
    const { rails } = clientWith({
      verify: { isValid: false, invalidReason: 'invalid_exact_evm_payload_signature' },
      settle: { success: false, errorReason: 'authorization already used', transaction: '', network: 'base-sepolia' },
    });
    await expect(rails.verify(evmHeader, requirement)).rejects.toMatchObject({
      code: 'verify_failed',
      message: 'invalid_exact_evm_payload_signature',
    });
    await expect(rails.settle(evmHeader, requirement)).rejects.toMatchObject({
      code: 'settle_failed',
      message: 'authorization already used',
    });
    await expect(rails.verify(evmHeader, requirement)).rejects.toBeInstanceOf(GateError);
  });
});
