import { PaymentRequirement, type FetchLike } from '@rein/sdk';
import { RailsError } from './errors.js';
import type { FacilitatorClient } from './facilitator.js';
import { BASE_SEPOLIA_USDC } from './wallet.js';
import { decodePaymentHeader, encodeSettlementHeader } from './wire.js';

export interface RealVendorOptions {
  facilitator: FacilitatorClient;
  /** Price in atomic units (e.g. "10000" = 0.01 USDC at 6 decimals). */
  atomicPrice: string;
  /** Where the vendor wants to be paid (a real EVM address). */
  payTo: string;
  network?: string;
  /** Token contract address. Defaults to USDC on Base Sepolia. */
  asset?: string;
  description?: string;
  maxTimeoutSeconds?: number;
  /** EIP-712 domain hints for the payer. Defaults to Base Sepolia USDC's. */
  extra?: Record<string, unknown>;
  /** JSON body served once payment settles. */
  body?: unknown;
}

export interface VendorCall {
  url: string;
  payment: string | null;
}

export interface RealVendor {
  /** Drop-in fetch for the guard's vendor-facing side. */
  fetch: FetchLike;
  /** Every request the vendor saw, in order. */
  calls: VendorCall[];
  /** The payment requirement this vendor quotes for a given URL. */
  requirementFor(url: string): PaymentRequirement;
}

/**
 * An in-process x402 vendor wired to a REAL facilitator: quotes a 402 with
 * payment requirements until the request carries X-PAYMENT, then verifies and
 * settles through the facilitator — a real on-chain USDC transfer — and serves
 * the content with the settlement (tx hash included) in X-PAYMENT-RESPONSE.
 *
 * Unlike the mock vendor, the quoted requirement is fully populated: the
 * hosted facilitator validates it strictly (resource must be a URL,
 * description/mimeType/maxTimeoutSeconds required, real addresses).
 */
export function createRealVendor(options: RealVendorOptions): RealVendor {
  const calls: VendorCall[] = [];

  const requirementFor = (url: string): PaymentRequirement =>
    PaymentRequirement.parse({
      scheme: 'exact',
      network: options.network ?? 'base-sepolia',
      maxAmountRequired: options.atomicPrice,
      resource: url,
      description: options.description ?? '',
      mimeType: 'application/json',
      payTo: options.payTo,
      maxTimeoutSeconds: options.maxTimeoutSeconds ?? 300,
      asset: options.asset ?? BASE_SEPOLIA_USDC,
      extra: options.extra ?? { name: 'USDC', version: '2' },
    });

  const paymentRequired = (url: string, error: string): Response =>
    new Response(JSON.stringify({ x402Version: 1, accepts: [requirementFor(url)], error }), {
      status: 402,
      headers: { 'content-type': 'application/json' },
    });

  const fetch: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const payment = headers.get('X-PAYMENT');
    calls.push({ url, payment });

    if (payment === null) return paymentRequired(url, 'X-PAYMENT header is required');

    const requirement = requirementFor(url);
    let payload;
    try {
      payload = decodePaymentHeader(payment);
    } catch (err) {
      if (err instanceof RailsError) return paymentRequired(url, err.message);
      throw err;
    }

    const verified = await options.facilitator.verify(payload, requirement);
    if (!verified.isValid) {
      return paymentRequired(url, verified.invalidReason ?? 'payment verification failed');
    }

    const settled = await options.facilitator.settle(payload, requirement);
    if (!settled.success) {
      return paymentRequired(url, settled.errorReason ?? 'payment settlement failed');
    }

    return new Response(JSON.stringify(options.body ?? { ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'X-PAYMENT-RESPONSE': encodeSettlementHeader(settled),
      },
    });
  };

  return { fetch, calls, requirementFor };
}
