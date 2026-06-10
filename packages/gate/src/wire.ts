import { z } from 'zod';
import { GateError } from './errors.js';

/**
 * The gate's view of an X-PAYMENT header. Both payload dialects Rein speaks —
 * the real exact-EVM scheme (EIP-3009 authorization nested under
 * `payload.authorization`) and the mock rails' flat payload — share the same
 * base64-JSON v1 envelope and carry the same transfer facts, so the gate can
 * screen payers and cross-check amounts BEFORE any facilitator round-trip.
 * Signature validity stays the rails' job; the gate never trusts these facts
 * for settlement, only for cheap early refusals.
 */

const UintString = z.string().regex(/^\d+$/, 'must be a decimal integer string');

const Transfer = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  /** Atomic-unit amount, mirroring the requirement's maxAmountRequired. */
  value: UintString,
});

const Envelope = z.object({
  x402Version: z.literal(1),
  scheme: z.string(),
  network: z.string(),
  payload: z.record(z.unknown()),
});

export interface InspectedPayment {
  scheme: string;
  network: string;
  /** The paying wallet address (`from` in the transfer). */
  payer: string;
  to: string;
  /** Atomic-unit amount. */
  value: string;
  /** The decoded envelope exactly as sent, for rails that re-verify it. */
  envelope: unknown;
}

export function inspectPaymentHeader(raw: string): InspectedPayment {
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new GateError('malformed_payment', 'X-PAYMENT is not base64-encoded JSON');
  }
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) {
    throw new GateError('malformed_payment', `invalid X-PAYMENT envelope: ${envelope.error.message}`);
  }
  // Exact-EVM nests the transfer in `authorization`; the mock payload is flat.
  const source = envelope.data.payload['authorization'] ?? envelope.data.payload;
  const transfer = Transfer.safeParse(source);
  if (!transfer.success) {
    throw new GateError(
      'malformed_payment',
      `X-PAYMENT carries no recognizable transfer: ${transfer.error.message}`,
    );
  }
  return {
    scheme: envelope.data.scheme,
    network: envelope.data.network,
    payer: transfer.data.from,
    to: transfer.data.to,
    value: transfer.data.value,
    envelope: json,
  };
}

/** Base64 the settlement for X-PAYMENT-RESPONSE (same codec all rails use). */
export function encodeSettlementHeader(response: unknown): string {
  return Buffer.from(JSON.stringify(response)).toString('base64');
}
