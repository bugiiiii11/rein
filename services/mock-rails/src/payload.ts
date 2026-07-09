import { z } from 'zod';
import { FacilitatorError } from './errors.js';

/**
 * Wire codecs for the two x402 headers the mock rails speak: `X-PAYMENT`
 * (agent -> vendor -> facilitator) and `X-PAYMENT-RESPONSE` (vendor -> agent).
 * Both are base64-encoded JSON per the x402 spec.
 */

/** The mock `exact` scheme payload carried inside X-PAYMENT. */
export const MockExactPayload = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** Atomic-unit amount, mirroring the requirement's maxAmountRequired. */
  value: z.string().regex(/^\d+$/, 'atomic amount must be an integer string'),
  asset: z.string().min(1),
  /**
   * Rein linkage: the guard's payer stamps the intent id here, the facilitator
   * memos it onto the ledger entry, and the indexer reconciles exactly. A real
   * x402 transfer authorization carries a nonce that serves the same role.
   */
  intentId: z.string().optional(),
  nonce: z.string().optional(),
});
export type MockExactPayload = z.infer<typeof MockExactPayload>;

/** The full X-PAYMENT header body (x402 spec v1 envelope). */
export const MockPaymentHeader = z.object({
  x402Version: z.literal(1),
  scheme: z.string(),
  network: z.string(),
  payload: MockExactPayload,
});
export type MockPaymentHeader = z.infer<typeof MockPaymentHeader>;

/**
 * The v2 envelope (PAYMENT-SIGNATURE header): scheme/network live inside
 * `accepted` — the requirement the payer chose — around the SAME scheme
 * payload. `.passthrough()` keeps resource/extensions intact.
 */
export const MockPaymentHeaderV2 = z
  .object({
    x402Version: z.literal(2),
    accepted: z
      .object({
        scheme: z.string(),
        network: z.string(),
        amount: z.string().regex(/^\d+$/, 'atomic amount must be an integer string'),
        asset: z.string().min(1),
        payTo: z.string().min(1),
      })
      .passthrough(),
    payload: MockExactPayload,
  })
  .passthrough();
export type MockPaymentHeaderV2 = z.infer<typeof MockPaymentHeaderV2>;

/** A payment as the facilitator sees it, whichever dialect it arrived in. */
export interface DecodedPayment {
  version: 1 | 2;
  scheme: string;
  network: string;
  payload: MockExactPayload;
}

export function encodePaymentHeader(header: MockPaymentHeader): string {
  return Buffer.from(JSON.stringify(header)).toString('base64');
}

export function decodePaymentHeader(raw: string): DecodedPayment {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new FacilitatorError('malformed_payment', 'X-PAYMENT is not base64-encoded JSON');
  }

  if ((json as { x402Version?: unknown } | null)?.x402Version === 2) {
    const parsed = MockPaymentHeaderV2.safeParse(json);
    if (!parsed.success) {
      throw new FacilitatorError(
        'malformed_payment',
        `invalid v2 payment envelope: ${parsed.error.message}`,
      );
    }
    // A self-contradictory envelope (accepted terms vs transfer payload) is
    // malformed on its face — mirroring the gate's inspection.
    if (parsed.data.payload.value !== parsed.data.accepted.amount) {
      throw new FacilitatorError(
        'malformed_payment',
        `v2 envelope contradicts itself: accepted.amount ${parsed.data.accepted.amount} vs payload value ${parsed.data.payload.value}`,
      );
    }
    return {
      version: 2,
      scheme: parsed.data.accepted.scheme,
      network: parsed.data.accepted.network,
      payload: parsed.data.payload,
    };
  }

  const parsed = MockPaymentHeader.safeParse(json);
  if (!parsed.success) {
    throw new FacilitatorError('malformed_payment', `invalid X-PAYMENT body: ${parsed.error.message}`);
  }
  return {
    version: 1,
    scheme: parsed.data.scheme,
    network: parsed.data.network,
    payload: parsed.data.payload,
  };
}

/** What the facilitator returns on settle; the vendor base64s it into X-PAYMENT-RESPONSE. */
export const SettlementResponse = z.object({
  success: z.boolean(),
  /** The tx hash on the mock ledger (the guard surfaces this on the receipt). */
  transaction: z.string(),
  network: z.string(),
  payer: z.string().optional(),
});
export type SettlementResponse = z.infer<typeof SettlementResponse>;

export function encodeSettlementHeader(response: SettlementResponse): string {
  return Buffer.from(JSON.stringify(response)).toString('base64');
}
