import { z } from 'zod';
import { RailsError } from './errors.js';

/**
 * Wire codecs for the real x402 v1 exact-EVM scheme: the `X-PAYMENT` header
 * the payer signs (EIP-3009 authorization + signature), the facilitator's
 * verify/settle responses, and the `X-PAYMENT-RESPONSE` header the vendor
 * returns. Verified against the published v1 spec and the hosted facilitator
 * at x402.org (2026-06).
 */

const Hex = z.string().regex(/^0x[0-9a-fA-F]*$/, 'must be 0x-prefixed hex');
const EvmAddress = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'must be a 20-byte EVM address');
const UintString = z.string().regex(/^\d+$/, 'must be a decimal integer string');

/** The EIP-3009 TransferWithAuthorization message, decimal-stringified. */
export const ExactEvmAuthorization = z.object({
  from: EvmAddress,
  to: EvmAddress,
  /** Atomic-unit amount, mirroring the requirement's maxAmountRequired. */
  value: UintString,
  validAfter: UintString,
  validBefore: UintString,
  /** bytes32 — Rein derives it from the intent id (see nonce.ts). */
  nonce: z.string().regex(/^0x[0-9a-fA-F]{64}$/, 'nonce must be bytes32 hex'),
});
export type ExactEvmAuthorization = z.infer<typeof ExactEvmAuthorization>;

export const ExactEvmPayload = z.object({
  /** 65-byte EIP-712 signature over the authorization. */
  signature: Hex,
  authorization: ExactEvmAuthorization,
});
export type ExactEvmPayload = z.infer<typeof ExactEvmPayload>;

/** The full X-PAYMENT header body (x402 spec v1 envelope). */
export const PaymentPayload = z.object({
  x402Version: z.literal(1),
  scheme: z.string(),
  network: z.string(),
  payload: ExactEvmPayload,
});
export type PaymentPayload = z.infer<typeof PaymentPayload>;

/** Facilitator POST /verify response. Reason strings stay lenient on purpose. */
export const VerifyResponse = z.object({
  isValid: z.boolean(),
  invalidReason: z.string().optional(),
  payer: z.string().optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponse>;

/** Facilitator POST /settle response (also what X-PAYMENT-RESPONSE carries). */
export const SettleResponse = z.object({
  success: z.boolean(),
  errorReason: z.string().optional(),
  payer: z.string().optional(),
  /** The on-chain tx hash (the guard surfaces this on the receipt). */
  transaction: z.string(),
  network: z.string(),
});
export type SettleResponse = z.infer<typeof SettleResponse>;

export function encodePaymentHeader(payload: PaymentPayload): string {
  return Buffer.from(JSON.stringify(payload)).toString('base64');
}

export function decodePaymentHeader(raw: string): PaymentPayload {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new RailsError('malformed_payment', 'X-PAYMENT is not base64-encoded JSON');
  }
  const parsed = PaymentPayload.safeParse(json);
  if (!parsed.success) {
    throw new RailsError('malformed_payment', `invalid X-PAYMENT body: ${parsed.error.message}`);
  }
  return parsed.data;
}

export function encodeSettlementHeader(response: SettleResponse): string {
  return Buffer.from(JSON.stringify(response)).toString('base64');
}
