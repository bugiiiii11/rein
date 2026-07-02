import type { FetchLike, PaymentRequirement } from '@rein/sdk';
import { FacilitatorHttpError } from './errors.js';
import { SettleResponse, VerifyResponse, type PaymentPayload } from './wire.js';

/** Coinbase's hosted testnet facilitator: free, no API key, v1 + base-sepolia. */
export const DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';

export interface FacilitatorClientOptions {
  /** Facilitator base URL. Defaults to the hosted x402.org testnet facilitator. */
  url?: string;
  /** Transport override (tests inject a stub here). Defaults to global fetch. */
  fetch?: FetchLike;
}

/** Any x402 payment envelope — the POST's x402Version is read off of it. */
export type AnyPaymentPayload = PaymentPayload | ({ x402Version: number } & Record<string, unknown>);
/** Requirements in whichever dialect matches the payload (v1 or v2 shape). */
export type AnyPaymentRequirements = PaymentRequirement | Record<string, unknown>;

/**
 * HTTP client for a real x402 facilitator (v1 AND v2 — x402.org serves both).
 * The vendor side of the rails: verify checks the payment signature against
 * the requirement, settle submits the EIP-3009 authorization on-chain (the
 * facilitator pays gas) and returns the tx hash. The POST's `x402Version` is
 * derived from the payload envelope itself, and the caller must pass
 * requirements in the SAME dialect (v2 payload → v2 `amount`/CAIP-2 shape;
 * @rein/gate's facilitatorClientRails does this conversion).
 */
export class FacilitatorClient {
  readonly url: string;
  private readonly fetch: FetchLike;

  constructor(options: FacilitatorClientOptions = {}) {
    this.url = (options.url ?? DEFAULT_FACILITATOR_URL).replace(/\/$/, '');
    const f = options.fetch ?? globalThis.fetch;
    this.fetch = (input, init) => f(input, init);
  }

  async verify(
    payload: AnyPaymentPayload,
    requirements: AnyPaymentRequirements,
  ): Promise<VerifyResponse> {
    return VerifyResponse.parse(await this.post('/verify', payload, requirements));
  }

  async settle(
    payload: AnyPaymentPayload,
    requirements: AnyPaymentRequirements,
  ): Promise<SettleResponse> {
    return SettleResponse.parse(await this.post('/settle', payload, requirements));
  }

  /** The facilitator's advertised (x402Version, scheme, network) kinds. */
  async supported(): Promise<unknown> {
    const res = await this.fetch(`${this.url}/supported`);
    if (!res.ok) throw new FacilitatorHttpError(res.status, await res.text());
    return res.json();
  }

  private async post(
    path: string,
    paymentPayload: AnyPaymentPayload,
    paymentRequirements: AnyPaymentRequirements,
  ): Promise<unknown> {
    // The payment travels DECODED (JSON object, not base64) and the
    // requirement is a single object, not the 402 body's accepts array.
    // Same envelope both versions; x402Version mirrors the payload's own.
    const claimed = (paymentPayload as { x402Version?: unknown }).x402Version;
    const x402Version = typeof claimed === 'number' ? claimed : 1;
    const res = await this.fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version, paymentPayload, paymentRequirements }),
    });
    if (!res.ok) throw new FacilitatorHttpError(res.status, await res.text());
    return res.json();
  }
}
