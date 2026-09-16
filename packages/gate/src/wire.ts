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

/**
 * The v2 envelope (PAYMENT-SIGNATURE header): scheme/network live inside
 * `accepted` — the requirement the payer chose — and the scheme payload keeps
 * the same authorization nesting. `.passthrough()` keeps resource/extensions
 * intact for rails that re-verify the envelope verbatim.
 */
const AcceptedV2 = z
  .object({
    scheme: z.string(),
    network: z.string(),
    amount: UintString,
    asset: z.string().min(1),
    payTo: z.string().min(1),
  })
  .passthrough();

const EnvelopeV2 = z
  .object({
    x402Version: z.literal(2),
    accepted: AcceptedV2,
    payload: z.record(z.unknown()),
  })
  .passthrough();

export interface InspectedPayment {
  /** Which wire dialect the payment arrived in. */
  version: 1 | 2;
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

/**
 * Longest payment header the gate will decode. A real x402 envelope is a few
 * hundred bytes of base64; 16 KiB leaves room for every dialect and any
 * facilitator extension, while refusing -- before `Buffer.from` allocates a
 * byte -- the multi-megabyte header a hostile client can attach for free.
 * (Node's own HTTP parser caps headers near this size; the gate is
 * transport-agnostic and the in-process fetch adapter has no such parser.)
 */
export const MAX_PAYMENT_HEADER_CHARS = 16_384;

export function inspectPaymentHeader(raw: string): InspectedPayment {
  if (raw.length > MAX_PAYMENT_HEADER_CHARS) {
    throw new GateError(
      'malformed_payment',
      `the payment header is ${raw.length} characters; the gate accepts at most ${MAX_PAYMENT_HEADER_CHARS}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    throw new GateError('malformed_payment', 'the payment header is not base64-encoded JSON');
  }

  const claimed = (json as { x402Version?: unknown } | null)?.x402Version;
  if (claimed === 2) {
    const envelope = EnvelopeV2.safeParse(json);
    if (!envelope.success) {
      throw new GateError(
        'malformed_payment',
        `invalid v2 payment envelope: ${envelope.error.message}`,
      );
    }
    const transfer = extractTransfer(envelope.data.payload, 'PAYMENT-SIGNATURE');
    // A self-contradictory envelope (accepted terms vs signed transfer) is
    // malformed on its face — no rails round-trip needed to refuse it.
    if (transfer.value !== envelope.data.accepted.amount) {
      throw new GateError(
        'malformed_payment',
        `v2 envelope contradicts itself: accepted.amount ${envelope.data.accepted.amount} vs signed value ${transfer.value}`,
      );
    }
    return {
      version: 2,
      scheme: envelope.data.accepted.scheme,
      network: envelope.data.accepted.network,
      payer: transfer.from,
      to: transfer.to,
      value: transfer.value,
      envelope: json,
    };
  }

  const envelope = Envelope.safeParse(json);
  if (!envelope.success) {
    throw new GateError('malformed_payment', `invalid X-PAYMENT envelope: ${envelope.error.message}`);
  }
  const transfer = extractTransfer(envelope.data.payload, 'X-PAYMENT');
  return {
    version: 1,
    scheme: envelope.data.scheme,
    network: envelope.data.network,
    payer: transfer.from,
    to: transfer.to,
    value: transfer.value,
    envelope: json,
  };
}

/** Exact-EVM nests the transfer in `authorization`; the mock payload is flat. */
function extractTransfer(
  payload: Record<string, unknown>,
  headerName: string,
): z.infer<typeof Transfer> {
  const source = payload['authorization'] ?? payload;
  const transfer = Transfer.safeParse(source);
  if (!transfer.success) {
    throw new GateError(
      'malformed_payment',
      `${headerName} carries no recognizable transfer: ${transfer.error.message}`,
    );
  }
  return transfer.data;
}

/** Base64 the settlement for X-PAYMENT-RESPONSE (same codec all rails use). */
export function encodeSettlementHeader(response: unknown): string {
  return Buffer.from(JSON.stringify(response)).toString('base64');
}
