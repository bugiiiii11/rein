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

export const Agent = z.object({
  id: AgentId,
  orgId: OrgId,
  name: z.string().min(1).max(200),
  /** On-chain ERC-8004 identity, if the agent is registered. */
  erc8004Id: z.string().optional(),
  wallets: z.array(AgentWallet).default([]),
  status: AgentStatus.default('active'),
  createdAt: z.coerce.date(),
});
export type Agent = z.infer<typeof Agent>;
