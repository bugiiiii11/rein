import { z } from 'zod';
import { DecisionId, IntentId } from './ids.js';

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
