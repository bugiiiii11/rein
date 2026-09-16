import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, LocalAccount } from 'viem';
import { caip2Of, type Payer, type PaymentRequirement } from '@reinconsole/sdk';
import { RailsError } from './errors.js';
import { chainIdForNetwork } from './networks.js';
import { profileForNetwork, TESTNET, type NetworkProfile } from './profiles.js';
import { intentNonce } from './nonce.js';
import { encodePaymentHeader, type ExactEvmAuthorization } from './wire.js';

/** The EIP-3009 type tuple USDC's FiatTokenV2 verifies against. */
export const transferWithAuthorizationTypes = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

/**
 * The slice of a wallet the payer needs: an address plus EIP-712 typed-data
 * signing. Any viem local account satisfies it — including hosted wallet
 * providers bridged through viem's `toAccount` (Coinbase CDP server wallets,
 * Privy, Turnkey, ...), which keeps custody with the provider while the
 * payer never sees a key.
 */
export type PayerAccount = Pick<LocalAccount, 'address' | 'signTypedData'>;

export interface X402PayerOptions {
  /** The agent wallet's private key (a local account; never leaves the process). Exactly one of privateKey/account. */
  privateKey?: Hex;
  /** An already-constructed signer, e.g. `toAccount(cdpAccount)`. Exactly one of privateKey/account. */
  account?: PayerAccount;
  /** How far into the past validAfter reaches, absorbing clock skew. */
  validAfterSkewSeconds?: number;
  /** validBefore window when the requirement omits maxTimeoutSeconds. */
  defaultTimeoutSeconds?: number;
  /** Injectable clock (unix seconds) for deterministic tests. */
  now?: () => number;
  /**
   * The networks this payer will sign for, as x402 ids in either dialect
   * (`base-sepolia`, `eip155:8453`, ...). Anything else raises
   * `unsupported_network` BEFORE a signature exists.
   *
   * Omitted means "any network these rails know", which is what every caller
   * before profiles got. Set it and a testnet payer can no longer be talked
   * into signing a mainnet authorization by a 402 that simply asks -- the
   * offer arrives from the vendor, so without an allow-list the vendor picks
   * which chain your key spends on.
   */
  networks?: readonly string[];
  /**
   * Network profile supplying the EIP-712 domain when the requirement does
   * not carry one. Optional, and worth passing on mainnet: see the fallback
   * in the signer below.
   */
  profile?: NetworkProfile;
}

/**
 * The real x402 `Payer`: signs an EIP-3009 TransferWithAuthorization for the
 * requirement's token (EIP-712, fully offline — no RPC) and returns the v1
 * X-PAYMENT header. Gasless for the agent: the facilitator submits the tx.
 *
 * The wallet is either a raw private key (local custody) or an injected
 * `PayerAccount` (provider custody — CDP, Privy, Turnkey via `toAccount`);
 * the envelope is identical either way.
 *
 * The authorization nonce is derived from the intent id, which is what lets
 * the on-chain indexer reconcile the settlement back to the decision that
 * allowed it (see nonce.ts).
 */
export function createX402Payer(options: X402PayerOptions): Payer {
  if (options.account !== undefined && options.privateKey !== undefined) {
    throw new TypeError('createX402Payer takes privateKey or account, not both');
  }
  const account: PayerAccount =
    options.account ??
    (options.privateKey !== undefined ? privateKeyToAccount(options.privateKey) : missingWallet());
  const skew = options.validAfterSkewSeconds ?? 600;
  const defaultTimeout = options.defaultTimeoutSeconds ?? 300;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  const allowed = options.networks?.map(caip2Of);

  return async (requirement, intent) => {
    const chainId = chainIdForNetwork(requirement.network);
    if (chainId === undefined) {
      throw new RailsError(
        'unsupported_network',
        `cannot sign for x402 network "${requirement.network}"`,
      );
    }
    // Checked against the CAIP-2 form so an allow-list written as
    // ['base-sepolia'] still refuses an offer spelled 'eip155:8453' and
    // accepts one spelled 'eip155:84532' -- the two dialects name the same
    // chains and a vendor chooses which it speaks.
    if (allowed && !allowed.includes(caip2Of(requirement.network))) {
      throw new RailsError(
        'unsupported_network',
        `network "${requirement.network}" is not in this payer's allow-list (${options.networks?.join(', ')})`,
      );
    }

    const ts = now();
    const authorization: ExactEvmAuthorization = {
      from: account.address,
      to: requirement.payTo as Hex,
      value: requirement.maxAmountRequired,
      validAfter: String(ts - skew),
      validBefore: String(ts + (requirement.maxTimeoutSeconds ?? defaultTimeout)),
      nonce: intentNonce(intent.id),
    };

    const signature = await account.signTypedData({
      domain: {
        // The requirement's own `extra` wins -- the vendor knows its token.
        // The fallback is the profile for the network being paid on, and only
        // then the Sepolia spelling. That order matters: `USDC`/`2` is right
        // on Base Sepolia and WRONG on Base mainnet, where the token is named
        // `USD Coin`, so a hardcoded fallback signs an authorization the
        // mainnet contract rejects at settlement -- a failure that appears
        // only with real money on the line. See profiles.ts.
        name: extraString(requirement, 'name') ?? domainDefaults(requirement, options.profile).name,
        version:
          extraString(requirement, 'version') ??
          domainDefaults(requirement, options.profile).version,
        chainId,
        verifyingContract: requirement.asset as Hex,
      },
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
    });

    return encodePaymentHeader({
      x402Version: 1,
      scheme: requirement.scheme,
      network: requirement.network,
      payload: { signature, authorization },
    });
  };
}

/** A payer without a wallet cannot exist — surface it at construction, not first payment. */
function missingWallet(): never {
  throw new TypeError('createX402Payer needs a wallet: pass privateKey or account');
}

/**
 * The EIP-712 domain to assume when the requirement omits one: the explicit
 * profile if the caller passed one, else the profile matching the offer's own
 * network, else Base Sepolia's spelling (what every caller got before
 * profiles existed, and correct for the network they were all on).
 */
function domainDefaults(
  requirement: PaymentRequirement,
  profile: NetworkProfile | undefined,
): { name: string; version: string } {
  return (profile ?? profileForNetwork(requirement.network) ?? TESTNET).eip712;
}

/** EIP-712 domain name/version travel in requirement.extra (per the v1 spec). */
function extraString(requirement: PaymentRequirement, key: string): string | undefined {
  const value = requirement.extra?.[key];
  return typeof value === 'string' ? value : undefined;
}
