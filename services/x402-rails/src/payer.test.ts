import { describe, it, expect } from 'vitest';
import { recoverTypedDataAddress, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PaymentIntent, newId, type Decision } from '@reinconsole/core';
import { PaymentRequirement } from '@reinconsole/sdk';
import { RailsError } from './errors.js';
import { intentNonce } from './nonce.js';
import { createX402Payer, transferWithAuthorizationTypes } from './payer.js';
import { BASE_USDC } from './profiles.js';
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

/**
 * The network allow-list and the EIP-712 domain fallback: the two places a
 * payer can be talked onto the wrong chain by a 402 it merely received.
 */
describe('createX402Payer network bounds', () => {
  it('signs for a network on the allow-list, in either dialect', async () => {
    const payer = createX402Payer({
      privateKey: KEY,
      now: () => NOW,
      networks: ['base-sepolia'],
    });
    await expect(payer(requirement(), intent(), decision)).resolves.toContain('');
    // The v1 name allow-listed it; the CAIP-2 spelling of the SAME chain is
    // the same permission, because the vendor picks which dialect it offers.
    await expect(
      payer(requirement({ network: 'eip155:84532' }), intent(), decision),
    ).resolves.toContain('');
  });

  /**
   * The offer comes from the vendor. Without this list, the vendor chooses
   * which chain the agent's key spends on — and the engine cannot object,
   * because networkToChain folds base-sepolia and base onto one chain.
   */
  it('refuses a network outside the allow-list before any signature exists', async () => {
    const payer = createX402Payer({
      privateKey: KEY,
      now: () => NOW,
      networks: ['base-sepolia'],
    });
    await expect(
      payer(requirement({ network: 'base' }), intent(), decision),
    ).rejects.toThrowError(RailsError);
    await expect(payer(requirement({ network: 'eip155:8453' }), intent(), decision)).rejects.toThrow(
      /allow-list/,
    );
  });

  it('signs any known network when no allow-list is given (the old behaviour)', async () => {
    const payer = createX402Payer({ privateKey: KEY, now: () => NOW });
    await expect(
      // Each network's OWN token: the address is pinned to the profile for the
      // network being paid, so `base` with the Sepolia contract is refused.
      payer(requirement({ network: 'base', asset: BASE_USDC }), intent(), decision),
    ).resolves.toContain('');
  });

  /**
   * The token contract used to be whatever the counterparty put in `asset`,
   * and it became the EIP-712 `verifyingContract` unexamined. Combined with
   * `extra.symbol`, that let any EIP-3009 token be presented as USDC: policy
   * evaluated the agent's USDC caps and the signature spent a different
   * balance entirely.
   */
  it('refuses a token that is not the profile’s USDC for that network', async () => {
    const payer = createX402Payer({ privateKey: KEY, now: () => NOW });
    const impostor = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'; // Ethereum USDC
    await expect(
      payer(
        requirement({ network: 'base', asset: impostor, extra: { symbol: 'USDC' } }),
        intent(),
        decision,
      ),
    ).rejects.toThrow(/requirement pays token 0xA0b86991/i);
  });

  it('refuses a network it cannot pin a contract for', async () => {
    const payer = createX402Payer({ privateKey: KEY, now: () => NOW });
    // `chainIdForNetwork` rejects an unknown name first; the profile pin is
    // the second line, for a network that HAS a chain id but no profile.
    await expect(payer(requirement({ network: 'avalanche' }), intent(), decision)).rejects.toThrow(
      /cannot sign for x402 network/i,
    );
    await expect(
      payer(requirement({ network: 'polygon' }), intent(), decision),
    ).rejects.toThrow(/cannot sign for x402 network|no pinned profile/i);
  });

  /**
   * A requirement that omits `extra` is where the mainnet domain bug lived:
   * the fallback used to be the hardcoded Sepolia spelling, so a mainnet
   * payment was signed against domain name "USDC" and the real contract —
   * which is "USD Coin" — would reject it at settlement.
   */
  it('falls back to the domain of the network being paid on, not to Sepolia', async () => {
    const seen: { name?: unknown }[] = [];
    const account = privateKeyToAccount(KEY);
    const spy = createX402Payer({
      account: {
        address: account.address,
        signTypedData: (params) => {
          seen.push(params.domain as { name?: unknown });
          return account.signTypedData(params);
        },
      },
      now: () => NOW,
    });

    const bare = { network: 'base', asset: BASE_USDC, extra: undefined };
    await spy(requirement(bare), intent(), decision);
    expect(seen.at(-1)?.name).toBe('USD Coin');

    // Sepolia's own contract, because the asset is pinned per network.
    await spy(
      requirement({ ...bare, network: 'base-sepolia', asset: USDC }),
      intent(),
      decision,
    );
    expect(seen.at(-1)?.name).toBe('USDC');

    // The vendor's own declaration still wins over both.
    await spy(requirement({ ...bare, extra: { name: 'Bridged USDC', version: '2' } }), intent(), decision);
    expect(seen.at(-1)?.name).toBe('Bridged USDC');
  });
});
