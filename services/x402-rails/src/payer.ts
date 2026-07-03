import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, LocalAccount } from 'viem';
import type { Payer, PaymentRequirement } from '@reinconsole/sdk';
import { RailsError } from './errors.js';
import { chainIdForNetwork } from './networks.js';
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

export interface X402PayerOptions {
  /** The agent wallet's private key (a local account; never leaves the process). */
  privateKey: Hex;
  /** How far into the past validAfter reaches, absorbing clock skew. */
  validAfterSkewSeconds?: number;
  /** validBefore window when the requirement omits maxTimeoutSeconds. */
  defaultTimeoutSeconds?: number;
  /** Injectable clock (unix seconds) for deterministic tests. */
  now?: () => number;
}

/**
 * The real x402 `Payer`: signs an EIP-3009 TransferWithAuthorization for the
 * requirement's token (EIP-712, fully offline — no RPC) and returns the v1
 * X-PAYMENT header. Gasless for the agent: the facilitator submits the tx.
 *
 * The authorization nonce is derived from the intent id, which is what lets
 * the on-chain indexer reconcile the settlement back to the decision that
 * allowed it (see nonce.ts).
 */
export function createX402Payer(options: X402PayerOptions): Payer {
  const account: LocalAccount = privateKeyToAccount(options.privateKey);
  const skew = options.validAfterSkewSeconds ?? 600;
  const defaultTimeout = options.defaultTimeoutSeconds ?? 300;
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));

  return async (requirement, intent) => {
    const chainId = chainIdForNetwork(requirement.network);
    if (chainId === undefined) {
      throw new RailsError(
        'unsupported_network',
        `cannot sign for x402 network "${requirement.network}"`,
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
        name: extraString(requirement, 'name') ?? 'USDC',
        version: extraString(requirement, 'version') ?? '2',
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

/** EIP-712 domain name/version travel in requirement.extra (per the v1 spec). */
function extraString(requirement: PaymentRequirement, key: string): string | undefined {
  const value = requirement.extra?.[key];
  return typeof value === 'string' ? value : undefined;
}
