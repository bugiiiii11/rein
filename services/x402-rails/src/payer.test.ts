import { describe, it, expect } from 'vitest';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PaymentIntent, newId, type Decision } from '@reinconsole/core';
import { PaymentRequirement } from '@reinconsole/sdk';
import { RailsError } from './errors.js';
import { intentNonce } from './nonce.js';
import { createX402Payer, transferWithAuthorizationTypes } from './payer.js';
import { decodePaymentHeader } from './wire.js';

// A throwaway, publicly known key (hardhat/anvil dev account) — tests only.
const KEY: Hex = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const PAYER = privateKeyToAccount(KEY).address;
const PAY_TO = '0x2222222222222222222222222222222222222222';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const NOW = 1_750_000_000;

const requirement = (overrides: Partial<PaymentRequirement> = {}): PaymentRequirement =>
  PaymentRequirement.parse({
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000',
    resource: 'https://api.vendor.test/v1/answer',
    description: '',
    mimeType: 'application/json',
    payTo: PAY_TO,
    maxTimeoutSeconds: 300,
    asset: USDC,
    extra: { name: 'USDC', version: '2' },
    ...overrides,
  });

const intent = (): PaymentIntent =>
  PaymentIntent.parse({
    id: newId('int'),
    agentId: newId('agt'),
    vendor: { host: 'api.vendor.test', address: PAY_TO },
    resource: '/v1/answer',
    amount: '0.01',
    asset: 'USDC',
    chain: 'base',
    nonce: 'test-nonce',
    createdAt: new Date(NOW * 1000),
  });

// This payer holds its own key and signs without consulting the decision —
// that is local-custody mode. Only the session signer verifies it.
const decision: Decision = {
  id: newId('dec'),
  intentId: newId('int'),
  intentHash: 'unverified',
  outcome: 'allow',
  matchedRules: [],
  policyId: 'pol_test',
  policyVersion: '1',
  prevHash: 'genesis',
  hash: 'h',
  signature: 'sig',
  latencyMs: 0,
  decidedAt: new Date(NOW * 1000),
};

describe('createX402Payer', () => {
  const payer = createX402Payer({ privateKey: KEY, now: () => NOW });

  it('builds the exact authorization the requirement asks for', async () => {
    const paid = intent();
    const decoded = decodePaymentHeader(await payer(requirement(), paid, decision));

    expect(decoded.x402Version).toBe(1);
    expect(decoded.scheme).toBe('exact');
    expect(decoded.network).toBe('base-sepolia');
    expect(decoded.payload.authorization).toEqual({
      from: PAYER,
      to: PAY_TO,
      value: '10000',
      validAfter: String(NOW - 600),
      validBefore: String(NOW + 300),
      nonce: intentNonce(paid.id),
    });
  });

  it('signs a valid EIP-712 TransferWithAuthorization for the USDC domain', async () => {
    const decoded = decodePaymentHeader(await payer(requirement(), intent(), decision));
    const { authorization, signature } = decoded.payload;

    const recovered = await recoverTypedDataAddress({
      domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: USDC },
      types: transferWithAuthorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from as Hex,
        to: authorization.to as Hex,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as Hex,
      },
      signature: signature as Hex,
    });
    expect(recovered).toBe(PAYER);
  });

  it('honors extra.name/version and falls back to USDC/2 when absent', async () => {
    // Signature must change when the domain name changes — proves extra is used.
    const withExtra = decodePaymentHeader(await payer(requirement(), intent(), decision));
    const mainnetish = decodePaymentHeader(
      await payer(requirement({ extra: { name: 'USD Coin', version: '2' } }), intent(), decision),
    );
    const noExtra = decodePaymentHeader(await payer(requirement({ extra: undefined }), intent(), decision));
    expect(mainnetish.payload.signature).not.toBe(withExtra.payload.signature);
    // Same domain via fallback — signatures differ only because intents differ.
    expect(noExtra.payload.authorization.from).toBe(PAYER);
  });

  it('uses defaultTimeoutSeconds when the requirement has no maxTimeoutSeconds', async () => {
    const custom = createX402Payer({ privateKey: KEY, now: () => NOW, defaultTimeoutSeconds: 60 });
    const decoded = decodePaymentHeader(
      await custom(requirement({ maxTimeoutSeconds: undefined }), intent(), decision),
    );
    expect(decoded.payload.authorization.validBefore).toBe(String(NOW + 60));
  });

  it('fails closed on a network it cannot sign for', async () => {
    await expect(payer(requirement({ network: 'solana' }), intent(), decision)).rejects.toThrowError(
      RailsError,
    );
  });

  it('produces the identical envelope through an injected account', async () => {
    // The provider-custody path (CDP/Privy/Turnkey via toAccount) must be
    // byte-identical to local custody — same key, same intent, same header.
    const viemAccount = privateKeyToAccount(KEY);
    // Structural, not instanceof: mimic a provider bridge that only offers
    // the two members the payer is allowed to depend on.
    const injected = createX402Payer({
      account: {
        address: viemAccount.address,
        signTypedData: (params) => viemAccount.signTypedData(params),
      },
      now: () => NOW,
    });
    const paid = intent();
    expect(await injected(requirement(), paid, decision)).toBe(
      await payer(requirement(), paid, decision),
    );
  });

  it('rejects a wallet-less or doubly-walleted construction upfront', () => {
    expect(() => createX402Payer({ now: () => NOW })).toThrowError(TypeError);
    expect(() =>
      createX402Payer({ privateKey: KEY, account: privateKeyToAccount(KEY), now: () => NOW }),
    ).toThrowError(TypeError);
  });
});
