import { describe, it, expect } from 'vitest';
import { PaymentIntent, newId, type Decision } from '@rein/core';
import type { PaymentRequirement } from '@rein/sdk';
import { MockLedger } from './ledger.js';
import { MockFacilitator } from './facilitator.js';
import { FacilitatorError } from './errors.js';
import { decodePaymentHeader, encodePaymentHeader } from './payload.js';

const requirement: PaymentRequirement = {
  scheme: 'exact',
  network: 'base',
  maxAmountRequired: '10000', // 0.01 USDC
  payTo: '0xVENDOR',
  asset: 'USDC',
};

const intent = PaymentIntent.parse({
  id: newId('int'),
  agentId: newId('agt'),
  vendor: { host: 'api.vendor.test', address: '0xVENDOR' },
  resource: '/v1/answer',
  amount: '0.01',
  asset: 'USDC',
  chain: 'base',
  nonce: 'nonce-1',
  createdAt: new Date(),
});

// The Payer seam carries the decision, but mock payers ignore it — that is
// precisely the SDK-mode gap the signer tier closes. Any decision will do.
const decision: Decision = {
  id: newId('dec'),
  intentId: intent.id,
  intentHash: 'unverified',
  outcome: 'allow',
  matchedRules: [],
  policyId: 'pol_test',
  policyVersion: '1',
  prevHash: 'genesis',
  hash: 'h',
  signature: 'sig',
  latencyMs: 0,
  decidedAt: new Date(),
};

function rails() {
  const ledger = new MockLedger();
  return { ledger, facilitator: new MockFacilitator({ ledger }) };
}

const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof FacilitatorError) return err.code;
    throw err;
  }
  throw new Error('expected a FacilitatorError');
};

describe('MockFacilitator', () => {
  it('payerFor() builds an X-PAYMENT header carrying the intent linkage', async () => {
    const { facilitator } = rails();
    const header = await facilitator.payerFor('0xAGENT')(requirement, intent, decision);

    const decoded = decodePaymentHeader(header);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('base');
    expect(decoded.payload).toMatchObject({
      from: '0xAGENT',
      to: '0xVENDOR',
      value: '10000',
      intentId: intent.id,
      nonce: 'nonce-1',
    });
  });

  it('settle() writes the transfer on the ledger with the intent id as memo', async () => {
    const { ledger, facilitator } = rails();
    const header = await facilitator.payerFor('0xAGENT')(requirement, intent, decision);

    const settled = facilitator.settle(header, requirement);

    expect(ledger.entries()).toEqual([settled.entry]);
    expect(settled.entry).toMatchObject({
      chain: 'base',
      asset: 'USDC',
      from: '0xAGENT',
      to: '0xVENDOR',
      amount: '0.01',
      memo: intent.id,
    });
    expect(settled.response).toMatchObject({
      success: true,
      transaction: settled.entry.txHash,
      network: 'base',
      payer: '0xAGENT',
    });
    // The vendor header decodes to the same response (what the guard parses).
    const roundTrip = JSON.parse(Buffer.from(settled.header, 'base64').toString('utf8'));
    expect(roundTrip).toEqual(settled.response);
  });

  it('refuses payments that do not match the requirement', async () => {
    const { facilitator } = rails();
    const pay = facilitator.payerFor('0xAGENT');

    const short = await pay({ ...requirement, maxAmountRequired: '5000' }, intent, decision);
    expect(code(() => facilitator.settle(short, requirement))).toBe('amount_mismatch');

    const elsewhere = await pay({ ...requirement, payTo: '0xATTACKER' }, intent, decision);
    expect(code(() => facilitator.settle(elsewhere, requirement))).toBe('recipient_mismatch');

    const otherNet = await pay({ ...requirement, network: 'polygon' }, intent, decision);
    expect(code(() => facilitator.settle(otherNet, requirement))).toBe('network_mismatch');
  });

  it('refuses schemes and networks it cannot settle', async () => {
    const { facilitator } = rails();

    const permit = encodePaymentHeader({
      x402Version: 1,
      scheme: 'permit',
      network: 'base',
      payload: { from: '0xAGENT', to: '0xVENDOR', value: '10000', asset: 'USDC' },
    });
    expect(code(() => facilitator.settle(permit, { ...requirement, scheme: 'permit' }))).toBe(
      'unsupported_scheme',
    );

    const arbitrum = { ...requirement, network: 'arbitrum' };
    const onArbitrum = await facilitator.payerFor('0xAGENT')(arbitrum, intent, decision);
    expect(code(() => facilitator.settle(onArbitrum, arbitrum))).toBe('unsupported_network');
  });

  it('refuses malformed X-PAYMENT headers', () => {
    const { facilitator } = rails();
    expect(code(() => facilitator.settle('!!definitely-not-a-payment!!', requirement))).toBe(
      'malformed_payment',
    );
    const wrongShape = Buffer.from(JSON.stringify({ hello: 'world' })).toString('base64');
    expect(code(() => facilitator.settle(wrongShape, requirement))).toBe('malformed_payment');
  });
});
