import { PaymentRequirement, type FetchLike } from '@rein/sdk';
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
 * payment requirements until the request carries X-PAYMENT, then settles
 * through the facilitator (writing the transfer on the mock ledger) and serves
 * the content with the settlement in X-PAYMENT-RESPONSE. The third leg of the
 * mock rails — guard pays it, indexer watches the ledger behind it.
 */
export function createMockVendor(options: MockVendorOptions): MockVendor {
  const calls: VendorCall[] = [];

  const requirementFor = (url: string): PaymentRequirement =>
    PaymentRequirement.parse({
      scheme: options.scheme ?? 'exact',
      network: options.network ?? 'base',
      maxAmountRequired: options.atomicPrice,
      resource: new URL(url).pathname,
      payTo: options.payTo,
      asset: options.asset ?? 'USDC',
    });

  const paymentRequired = (url: string, error: string): Response =>
    new Response(
      JSON.stringify({ x402Version: 1, accepts: [requirementFor(url)], error }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    );

  const fetch: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );
    const payment = headers.get('X-PAYMENT');
    calls.push({ url, payment });

    if (payment === null) return paymentRequired(url, 'X-PAYMENT header is required');

    let settled;
    try {
      settled = options.facilitator.settle(payment, requirementFor(url));
    } catch (err) {
      if (err instanceof FacilitatorError) return paymentRequired(url, err.message);
      throw err;
    }
    return new Response(JSON.stringify(options.body ?? { ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'X-PAYMENT-RESPONSE': settled.header },
    });
  };

  return { fetch, calls, requirementFor };
}
