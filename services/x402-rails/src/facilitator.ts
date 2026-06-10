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

/**
 * HTTP client for a real x402 v1 facilitator. The vendor side of the rails:
 * verify checks the payment signature against the requirement, settle submits
 * the EIP-3009 authorization on-chain (the facilitator pays gas) and returns
 * the tx hash.
 */
export class FacilitatorClient {
  readonly url: string;
  private readonly fetch: FetchLike;

  constructor(options: FacilitatorClientOptions = {}) {
    this.url = (options.url ?? DEFAULT_FACILITATOR_URL).replace(/\/$/, '');
    const f = options.fetch ?? globalThis.fetch;
    this.fetch = (input, init) => f(input, init);
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirement): Promise<VerifyResponse> {
    return VerifyResponse.parse(await this.post('/verify', payload, requirements));
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirement): Promise<SettleResponse> {
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
    paymentPayload: PaymentPayload,
    paymentRequirements: PaymentRequirement,
  ): Promise<unknown> {
    // v1 envelope: the payment travels DECODED (JSON object, not base64) and
    // the requirement is a single object, not the 402 body's accepts array.
    const res = await this.fetch(`${this.url}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ x402Version: 1, paymentPayload, paymentRequirements }),
    });
    if (!res.ok) throw new FacilitatorHttpError(res.status, await res.text());
    return res.json();
  }
}
