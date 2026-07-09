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

/**
 * The v2 envelope (PAYMENT-SIGNATURE header): scheme/network live inside
 * `accepted` — the requirement the payer chose — around the SAME signed
 * scheme payload as v1. `.passthrough()` keeps resource/extensions intact
 * because the facilitator re-verifies the envelope verbatim.
 */
export const PaymentPayloadV2 = z
  .object({
    x402Version: z.literal(2),
    accepted: z
      .object({
        scheme: z.string(),
        /** CAIP-2, e.g. "eip155:84532". */
        network: z.string(),
        amount: UintString,
        asset: z.string().min(1),
        payTo: z.string().min(1),
      })
      .passthrough(),
    payload: ExactEvmPayload,
  })
  .passthrough();
export type PaymentPayloadV2 = z.infer<typeof PaymentPayloadV2>;

/** A payment as the vendor sees it, whichever dialect it arrived in. */
export interface DecodedPayment {
  version: 1 | 2;
  scheme: string;
  network: string;
  payload: ExactEvmPayload;
  /** The decoded envelope exactly as sent — what travels to the facilitator. */
  envelope: PaymentPayload | PaymentPayloadV2;
}

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

/**
 * Decode a payment header in EITHER dialect to one normalized view. The v2
 * envelope wraps the SAME signed scheme payload as v1, so both unwrap to a
 * single ExactEvmPayload; the envelope is kept verbatim for the facilitator,
 * which wants the payment in the dialect it was presented in.
 */
export function decodeAnyPaymentHeader(raw: string): DecodedPayment {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new RailsError('malformed_payment', 'the payment header is not base64-encoded JSON');
  }

  if ((json as { x402Version?: unknown } | null)?.x402Version === 2) {
    const parsed = PaymentPayloadV2.safeParse(json);
    if (!parsed.success) {
      throw new RailsError(
        'malformed_payment',
        `invalid v2 payment envelope: ${parsed.error.message}`,
      );
    }
    // A self-contradictory envelope (accepted terms vs signed authorization)
    // is malformed on its face — mirroring the gate's inspection.
    if (parsed.data.payload.authorization.value !== parsed.data.accepted.amount) {
      throw new RailsError(
        'malformed_payment',
        `v2 envelope contradicts itself: accepted.amount ${parsed.data.accepted.amount} vs signed value ${parsed.data.payload.authorization.value}`,
      );
    }
    return {
      version: 2,
      scheme: parsed.data.accepted.scheme,
      network: parsed.data.accepted.network,
      payload: parsed.data.payload,
      envelope: parsed.data,
    };
  }

  const parsed = PaymentPayload.safeParse(json);
  if (!parsed.success) {
    throw new RailsError('malformed_payment', `invalid X-PAYMENT body: ${parsed.error.message}`);
  }
  return {
    version: 1,
    scheme: parsed.data.scheme,
    network: parsed.data.network,
    payload: parsed.data.payload,
    envelope: parsed.data,
  };
}

export function encodeSettlementHeader(response: SettleResponse): string {
  return Buffer.from(JSON.stringify(response)).toString('base64');
}
