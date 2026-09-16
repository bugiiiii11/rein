import { z } from 'zod';
import { caip2Of, PaymentRequirement } from './x402.js';

// caip2Of/sameNetwork LIVE in x402.ts: selectRequirement's network allow-list
// needs them, and importing them back up from here would close a cycle
// through this module's zod consts. Re-exported so the v2 dialect still
// reads as their home.
export { caip2Of, sameNetwork } from './x402.js';

/**
 * x402 v2 wire dialect — CAIP-2 network ids, `PAYMENT-REQUIRED` /
 * `PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE` headers, base64-JSON payloads.
 * Verified against the published spec (coinbase/x402
 * specs/x402-specification-v2.md + transports-v2/http.md, re-checked 2026-07)
 * and the live facilitator's /supported.
 *
 * Rein's internal requirement shape stays v1 (the zod contract in x402.ts);
 * v2 is a WIRE dialect converted at the edges. Inbound, the guard converts a
 * PAYMENT-REQUIRED quote into internal requirements. Outbound, it REWRAPS the
 * payer's v1 X-PAYMENT envelope into the v2 PaymentPayload: the scheme payload
 * (e.g. the signed EIP-3009 authorization) is byte-identical in both dialects,
 * so every Payer — mock, EIP-3009, session-signer — is v2-capable without
 * knowing v2 exists. The vendor side (@reinconsole/gate) re-exports these
 * helpers rather than owning its own copies.
 */

/** x402 v2 PaymentRequirements (one entry of a 402's `accepts`). */
export const PaymentRequirementsV2 = z.object({
  scheme: z.string(),
  /** CAIP-2, e.g. "eip155:84532". */
  network: z.string(),
  /** Atomic units — v2's rename of v1's maxAmountRequired. */
  amount: z.string().regex(/^\d+$/, 'atomic amount must be an integer string'),
  asset: z.string().min(1),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().optional(),
  extra: z.record(z.unknown()).optional(),
});
export type PaymentRequirementsV2 = z.infer<typeof PaymentRequirementsV2>;

/** v2 ResourceInfo — resource facts move out of the requirement in v2. */
export const ResourceInfoV2 = z.object({
  url: z.string(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
});
export type ResourceInfoV2 = z.infer<typeof ResourceInfoV2>;

/** v2 PaymentRequired — the decoded PAYMENT-REQUIRED header. */
export const PaymentRequiredV2 = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: ResourceInfoV2.optional(),
  accepts: z.array(PaymentRequirementsV2).min(1),
  extensions: z.record(z.unknown()).optional(),
});
export type PaymentRequiredV2 = z.infer<typeof PaymentRequiredV2>;

/** Convert Rein's internal (v1-shaped) requirement to the v2 wire shape. */
export function v2Requirements(requirement: PaymentRequirement): PaymentRequirementsV2 {
  return {
    scheme: requirement.scheme,
    network: caip2Of(requirement.network),
    amount: requirement.maxAmountRequired,
    asset: requirement.asset,
    payTo: requirement.payTo,
    ...(requirement.maxTimeoutSeconds !== undefined
      ? { maxTimeoutSeconds: requirement.maxTimeoutSeconds }
      : {}),
    ...(requirement.extra ? { extra: requirement.extra } : {}),
  };
}

/**
 * The inverse: a v2 offer (plus the 402's shared ResourceInfo) as an internal
 * requirement. The CAIP-2 network id is kept verbatim — networkToChain and
 * chainIdForNetwork resolve both dialects, and sameNetwork compares across
 * them, so nothing downstream needs the v1 spelling back.
 */
export function requirementFromV2(
  offer: PaymentRequirementsV2,
  resource?: ResourceInfoV2,
): PaymentRequirement {
  return PaymentRequirement.parse({
    scheme: offer.scheme,
    network: offer.network,
    maxAmountRequired: offer.amount,
    payTo: offer.payTo,
    asset: offer.asset,
    ...(resource !== undefined ? { resource: resource.url } : {}),
    ...(resource?.description !== undefined ? { description: resource.description } : {}),
    ...(resource?.mimeType !== undefined ? { mimeType: resource.mimeType } : {}),
    ...(offer.maxTimeoutSeconds !== undefined
      ? { maxTimeoutSeconds: offer.maxTimeoutSeconds }
      : {}),
    ...(offer.extra ? { extra: offer.extra } : {}),
  });
}

/** The full v2 PaymentRequired for one quoted requirement. */
export function buildPaymentRequiredV2(
  requirement: PaymentRequirement,
  error: string,
): PaymentRequiredV2 {
  return {
    x402Version: 2,
    error,
    ...(requirement.resource
      ? {
          resource: {
            url: requirement.resource,
            ...(requirement.description ? { description: requirement.description } : {}),
            ...(requirement.mimeType ? { mimeType: requirement.mimeType } : {}),
          },
        }
      : {}),
    accepts: [v2Requirements(requirement)],
    extensions: {},
  };
}

/** The one codec every x402 header uses: base64 of compact JSON. */
export function encodeBase64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64');
}

/** Base64 JSON → value, or undefined when the header is not decodable. */
function decodeBase64Json(raw: string): unknown {
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Decode a PAYMENT-REQUIRED response header. Lenient by design: a missing,
 * undecodable, or non-v2 header returns undefined so callers fall back to the
 * v1 body — a garbled v2 advertisement must not break a dual-stack 402.
 */
export function parsePaymentRequiredHeader(raw: string | null): PaymentRequiredV2 | undefined {
  if (raw === null) return undefined;
  const parsed = PaymentRequiredV2.safeParse(decodeBase64Json(raw));
  return parsed.success ? parsed.data : undefined;
}

/** The v1 X-PAYMENT envelope, as far as the v2 rewrap needs to see it. */
const V1Envelope = z.object({
  x402Version: z.literal(1),
  scheme: z.string(),
  network: z.string(),
  payload: z.record(z.unknown()),
});

/**
 * Rewrap a payer's v1 X-PAYMENT header as a v2 PaymentPayload for the
 * PAYMENT-SIGNATURE header. The scheme payload transfers verbatim (what the
 * payer signed is envelope-independent); the chosen requirement rides along
 * as `accepted` per the v2 spec. A header that is already a v2 envelope
 * passes through unchanged. Throws TypeError on anything else — a payer
 * returning an unrecognizable header is a programming error, not wire input.
 */
export function wrapPaymentV2(
  paymentHeader: string,
  requirement: PaymentRequirement,
  resource?: ResourceInfoV2,
): string {
  const decoded = decodeBase64Json(paymentHeader);
  if ((decoded as { x402Version?: unknown } | undefined)?.x402Version === 2) {
    return paymentHeader;
  }
  const v1 = V1Envelope.safeParse(decoded);
  if (!v1.success) {
    throw new TypeError(`cannot rewrap payment header as x402 v2: ${v1.error.message}`);
  }
  return encodeBase64Json({
    x402Version: 2,
    ...(resource !== undefined ? { resource } : {}),
    accepted: v2Requirements(requirement),
    payload: v1.data.payload,
    extensions: {},
  });
}
