import { z } from 'zod';

/** Crockford base32 ULID body (26 chars), as produced by `ulid()`. */
const ULID_BODY = '[0-9A-HJKMNP-TV-Z]{26}';

/**
 * A zod schema for a Stripe-style prefixed ULID, e.g. `agt_01J7...`.
 * Centralizing this keeps id formats consistent across DB rows, API payloads,
 * and SDK types.
 */
export function prefixedId(prefix: string) {
  return z
    .string()
    .regex(new RegExp(`^${prefix}_${ULID_BODY}$`), `expected a "${prefix}_" prefixed id`);
}

export const OrgId = prefixedId('org');
export const AgentId = prefixedId('agt');
export const PolicyId = prefixedId('pol');
export const IntentId = prefixedId('int');
export const DecisionId = prefixedId('dec');
export const ReceiptId = prefixedId('rcp');
export const SessionId = prefixedId('ses');
export const GateReceiptId = prefixedId('grc');
export const ApiKeyId = prefixedId('key');
export const ApproverKeyId = prefixedId('apk');

export type OrgId = z.infer<typeof OrgId>;
export type AgentId = z.infer<typeof AgentId>;
export type PolicyId = z.infer<typeof PolicyId>;
export type IntentId = z.infer<typeof IntentId>;
export type DecisionId = z.infer<typeof DecisionId>;
export type ReceiptId = z.infer<typeof ReceiptId>;
export type SessionId = z.infer<typeof SessionId>;
export type GateReceiptId = z.infer<typeof GateReceiptId>;
export type ApiKeyId = z.infer<typeof ApiKeyId>;
export type ApproverKeyId = z.infer<typeof ApproverKeyId>;
