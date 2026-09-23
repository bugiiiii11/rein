import { z } from 'zod';
import { AgentId, DecisionId, IntentId } from './ids.js';

export const DecisionOutcome = z.enum(['allow', 'deny', 'escalate']);
export type DecisionOutcome = z.infer<typeof DecisionOutcome>;

/**
 * The signed, hash-chained record of a single policy evaluation. Written BEFORE
 * any signature is released. `prevHash` + `hash` form a tamper-evident chain;
 * `signature` is the policy service's signing key over `hash`. The eventual
 * on-chain `txHash` is attached later by the indexer (see SettledPayment).
 */
export const Decision = z.object({
  id: DecisionId,
  intentId: IntentId,
  /**
   * sha256 of the intent's canonical content (see canonical.ts). Binds the
   * decision to the exact transfer it judged — amount, recipient, asset,
   * chain — so a signer can verify an {intent, decision} pair offline as a
   * self-contained spend voucher, not just a reference by id.
   */
  intentHash: z.string(),
  outcome: DecisionOutcome,
  /** Ids of the rules that fired, for explainability. */
  matchedRules: z.array(z.string()).default([]),
  /** Human-readable explanation surfaced in the dashboard. */
  reason: z.string().optional(),
  policyId: z.string(),
  policyVersion: z.string(),
  /** Hash of the previous decision in the chain (tamper-evident log). */
  prevHash: z.string(),
  /** Hash of this decision's canonical content. */
  hash: z.string(),
  /** Service signing-key signature over `hash`. */
  signature: z.string(),
  latencyMs: z.number().nonnegative(),
  decidedAt: z.coerce.date(),
});
export type Decision = z.infer<typeof Decision>;

/**
 * A decision as `GET /v1/decisions` serves it (0.3.0): the signed record plus
 * `agentId`, the agent whose intent it judged.
 *
 * `agentId` is an ENVELOPE field -- the engine's own attribution, outside
 * `hash` and `signature`, so a verified chain vouches for nothing about it.
 * Putting it inside would have changed the hash of every future decision and
 * split the chain into two formats. It is here for a reconciler that is not
 * co-located with the agent: `reconcile()` needs an allowed intent's agent,
 * or agent B's payment against A's intent is credited to A (S74), and before
 * this field only `/v1/reconciliation` carried it -- and erases it the moment
 * a settlement lands. Absent on an unattributed (pre-tenancy) row.
 */
export const AttributedDecision = Decision.extend({ agentId: AgentId.optional() });
export type AttributedDecision = z.infer<typeof AttributedDecision>;
