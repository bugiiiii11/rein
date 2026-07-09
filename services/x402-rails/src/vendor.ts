import {
  PaymentRequirement,
  buildPaymentRequiredV2,
  encodeBase64Json,
  sameNetwork,
  v2Requirements,
  type FetchLike,
} from '@reinconsole/sdk';
import { RailsError } from './errors.js';
import type { FacilitatorClient } from './facilitator.js';
import { BASE_SEPOLIA_USDC } from './wallet.js';
import { decodeAnyPaymentHeader, encodeSettlementHeader } from './wire.js';

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
  /**
   * Which x402 dialect the vendor's 402s advertise. 'v1' (default) is the
   * classic JSON body; 'dual' adds the v2 PAYMENT-REQUIRED header beside it;
   * 'v2' advertises ONLY the header (the body is not x402) — a strict v2
   * vendor for proving clients need no v1 fallback. Payments are ACCEPTED in
   * both dialects (PAYMENT-SIGNATURE or X-PAYMENT) regardless of this option,
   * mirroring the gate.
   */
  advertise?: 'v1' | 'dual' | 'v2';
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
 * payment requirements until the request carries a payment, then verifies and
 * settles through the facilitator — a real on-chain USDC transfer — and serves
 * the content with the settlement (tx hash included) in the response headers.
 * Dual-stack like the gate: payments are accepted on X-PAYMENT (v1) and
 * PAYMENT-SIGNATURE (v2) alike, and `advertise` picks which dialect the 402s
 * quote in.
 *
 * Unlike the mock vendor, the quoted requirement is fully populated: the
 * hosted facilitator validates it strictly (resource must be a URL,
 * description/mimeType/maxTimeoutSeconds required, real addresses).
 */
export function createRealVendor(options: RealVendorOptions): RealVendor {
  const calls: VendorCall[] = [];
  const advertise = options.advertise ?? 'v1';

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

  const paymentRequired = (url: string, error: string): Response => {
    const requirement = requirementFor(url);
    // A strict v2 vendor's body is deliberately NOT x402 — everything the
    // protocol needs rides the PAYMENT-REQUIRED header.
    const body =
      advertise === 'v2' ? { error } : { x402Version: 1, accepts: [requirement], error };
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: {
        'content-type': 'application/json',
        ...(advertise !== 'v1'
          ? { 'PAYMENT-REQUIRED': encodeBase64Json(buildPaymentRequiredV2(requirement, error)) }
          : {}),
      },
    });
  };

  const fetch: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    // Dual-stack: v2 payers send PAYMENT-SIGNATURE, v1 payers X-PAYMENT.
    const payment = headers.get('PAYMENT-SIGNATURE') ?? headers.get('X-PAYMENT');
    calls.push({ url, payment });

    if (payment === null) return paymentRequired(url, 'payment is required');

    const requirement = requirementFor(url);
    let decoded;
    try {
      decoded = decodeAnyPaymentHeader(payment);
    } catch (err) {
      if (err instanceof RailsError) return paymentRequired(url, err.message);
      throw err;
    }

    // Compared through CAIP-2 normalization: a v2 envelope naming
    // "eip155:84532" satisfies this requirement's v1 "base-sepolia".
    if (!sameNetwork(decoded.network, requirement.network)) {
      return paymentRequired(
        url,
        `payment is on "${decoded.network}" but the requirement wants "${requirement.network}"`,
      );
    }

    // Requirements travel to the facilitator in the payment's own dialect —
    // a v2 envelope is verified against v2-shaped (amount/CAIP-2) requirements.
    const requirements = decoded.version === 2 ? v2Requirements(requirement) : requirement;
    const verified = await options.facilitator.verify(decoded.envelope, requirements);
    if (!verified.isValid) {
      return paymentRequired(url, verified.invalidReason ?? 'payment verification failed');
    }

    const settled = await options.facilitator.settle(decoded.envelope, requirements);
    if (!settled.success) {
      return paymentRequired(url, settled.errorReason ?? 'payment settlement failed');
    }

    const settlement = encodeSettlementHeader(settled);
    return new Response(JSON.stringify(options.body ?? { ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // Both dialect names carry the same base64 settlement object; the
        // strict v2 vendor sets ONLY the v2 name.
        ...(advertise !== 'v2' ? { 'X-PAYMENT-RESPONSE': settlement } : {}),
        'PAYMENT-RESPONSE': settlement,
      },
    });
  };

  return { fetch, calls, requirementFor };
}
