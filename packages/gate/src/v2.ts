import type { PaymentRequirement } from '@rein/sdk';

/**
 * x402 v2 wire builders (vendor side). Verified against the published spec
 * (coinbase/x402 specs/x402-specification-v2.md + transports-v2/http.md) and
 * the live facilitator's /supported (2026-07):
 *
 * - Requirements rename `maxAmountRequired` → `amount`, move resource fields
 *   out into a `ResourceInfo` object, and use CAIP-2 network ids.
 * - All protocol data travels in headers: 402s carry `PAYMENT-REQUIRED`
 *   (base64 PaymentRequired), clients pay with `PAYMENT-SIGNATURE` (base64
 *   PaymentPayload), settlements return in `PAYMENT-RESPONSE`.
 *
 * Rein's internal requirement shape stays v1 (the zod contract in @rein/sdk);
 * v2 is a WIRE dialect converted at the edges by the helpers here.
 */

/**
 * Known v1 network names → CAIP-2. EVM entries are chain-id math; the Solana
 * ids are what the live facilitator advertises. Unknown names pass through
 * lowercased, so two spellings of an UNKNOWN network still compare equal.
 */
const CAIP2_ALIASES: Record<string, string> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  bnb: 'eip155:56',
  bsc: 'eip155:56',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

/** The CAIP-2 id for a network name, or the lowercased name when unknown. */
export function caip2Of(network: string): string {
  const key = network.toLowerCase();
  return CAIP2_ALIASES[key] ?? key;
}

/** Do two network ids name the same chain, across the v1/CAIP-2 divide? */
export function sameNetwork(a: string, b: string): boolean {
  return caip2Of(a) === caip2Of(b);
}

/** x402 v2 PaymentRequirements (one entry of a 402's `accepts`). */
export interface PaymentRequirementsV2 {
  scheme: string;
  /** CAIP-2, e.g. "eip155:84532". */
  network: string;
  /** Atomic units — v2's rename of v1's maxAmountRequired. */
  amount: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: Record<string, unknown>;
}

/** v2 PaymentRequired — the decoded PAYMENT-REQUIRED header. */
export interface PaymentRequiredV2 {
  x402Version: 2;
  error?: string;
  resource?: { url: string; description?: string; mimeType?: string };
  accepts: PaymentRequirementsV2[];
  extensions?: Record<string, unknown>;
}

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
