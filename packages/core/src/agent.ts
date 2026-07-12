import { z } from 'zod';
import { AgentId, OrgId } from './ids.js';
import { Chain } from './chain.js';

/**
 * Enforcement tier of a given agent wallet:
 * - `observed`    — Rein sees spend on-chain but has no control (no SDK either).
 * - `sdk`         — agent uses @reinconsole/sdk; advisory + observability (bypassable).
 * - `session-key` — signer-level scope; out-of-policy txs cannot be signed.
 */
export const EnforcementMode = z.enum(['observed', 'sdk', 'session-key']);
export type EnforcementMode = z.infer<typeof EnforcementMode>;

export const AgentWallet = z.object({
  chain: Chain,
  address: z.string().min(1),
  mode: EnforcementMode,
});
export type AgentWallet = z.infer<typeof AgentWallet>;

export const AgentStatus = z.enum(['active', 'frozen']);
export type AgentStatus = z.infer<typeof AgentStatus>;

/**
 * A semantic grouping label, e.g. "research" or "prod-trading". Lowercase
 * slugs only — policy `appliesTo.labels` matches these (with globs), and a
 * case-normalization mismatch would silently un-target a policy.
 */
export const AgentLabel = z
  .string()
  .max(40)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'label must be a lowercase slug like "research" or "prod-trading"');
export type AgentLabel = z.infer<typeof AgentLabel>;

export const Agent = z.object({
  id: AgentId,
  orgId: OrgId,
  name: z.string().min(1).max(200),
  /** On-chain ERC-8004 identity, if the agent is registered. */
  erc8004Id: z.string().optional(),
  /** Semantic grouping labels — the targets of policy `appliesTo.labels`. */
  labels: z
    .array(AgentLabel)
    .max(16)
    .refine((ls) => new Set(ls).size === ls.length, { message: 'labels must be unique' })
    .default([]),
  wallets: z.array(AgentWallet).default([]),
  status: AgentStatus.default('active'),
  createdAt: z.coerce.date(),
});
export type Agent = z.infer<typeof Agent>;
