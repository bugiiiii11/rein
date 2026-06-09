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

export function encodePaymentHeader(header: MockPaymentHeader): string {
  return Buffer.from(JSON.stringify(header)).toString('base64');
}

export function decodePaymentHeader(raw: string): MockPaymentHeader {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new FacilitatorError('malformed_payment', 'X-PAYMENT is not base64-encoded JSON');
  }
  const parsed = MockPaymentHeader.safeParse(json);
  if (!parsed.success) {
    throw new FacilitatorError('malformed_payment', `invalid X-PAYMENT body: ${parsed.error.message}`);
  }
  return parsed.data;
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
