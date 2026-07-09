import {
  PaymentRequirement,
  buildPaymentRequiredV2,
  encodeBase64Json,
  type FetchLike,
} from '@reinconsole/sdk';
import { FacilitatorError } from './errors.js';
import type { MockFacilitator } from './facilitator.js';

export interface MockVendorOptions {
  facilitator: MockFacilitator;
  /** Price in atomic units (e.g. "10000" = 0.01 USDC at 6 decimals). */
  atomicPrice: string;
  /** Where the vendor wants to be paid. */
  payTo: string;
  network?: string;
  asset?: string;
  scheme?: string;
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

export interface MockVendor {
  /** Drop-in fetch for the guard's vendor-facing side. */
  fetch: FetchLike;
  /** Every request the vendor saw, in order. */
  calls: VendorCall[];
  /** The payment requirement this vendor quotes for a given URL. */
  requirementFor(url: string): PaymentRequirement;
}

/**
 * An in-process x402 vendor wired to the mock facilitator: quotes a 402 with
 * payment requirements until the request carries a payment, then settles
 * through the facilitator (writing the transfer on the mock ledger) and serves
 * the content with the settlement in the response headers. The third leg of
 * the mock rails — guard pays it, indexer watches the ledger behind it.
 */
export function createMockVendor(options: MockVendorOptions): MockVendor {
  const calls: VendorCall[] = [];
  const advertise = options.advertise ?? 'v1';

  const requirementFor = (url: string): PaymentRequirement =>
    PaymentRequirement.parse({
      scheme: options.scheme ?? 'exact',
      network: options.network ?? 'base',
      maxAmountRequired: options.atomicPrice,
      resource: new URL(url).pathname,
      payTo: options.payTo,
      asset: options.asset ?? 'USDC',
    });

  const paymentRequired = (url: string, error: string): Response => {
    const requirement = requirementFor(url);
    // A strict v2 vendor's body is deliberately NOT x402 — everything the
    // protocol needs rides the PAYMENT-REQUIRED header.
    const body =
      advertise === 'v2'
        ? { error }
        : { x402Version: 1, accepts: [requirement], error };
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: {
        'content-type': 'application/json',
        ...(advertise !== 'v1'
          ? {
              'PAYMENT-REQUIRED': encodeBase64Json(buildPaymentRequiredV2(requirement, error)),
            }
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

    let settled;
    try {
      settled = options.facilitator.settle(payment, requirementFor(url));
    } catch (err) {
      if (err instanceof FacilitatorError) return paymentRequired(url, err.message);
      throw err;
    }
    return new Response(JSON.stringify(options.body ?? { ok: true }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        // Both dialect names carry the same base64 settlement object; the
        // strict v2 vendor sets ONLY the v2 name.
        ...(advertise !== 'v2' ? { 'X-PAYMENT-RESPONSE': settled.header } : {}),
        'PAYMENT-RESPONSE': settled.header,
      },
    });
  };

  return { fetch, calls, requirementFor };
}
