import { z } from 'zod';
import { Chain } from './chain.js';
import { DecimalString } from './money.js';

/** A rolling-window spec, e.g. "24h", "1h", "30m", "7d". */
export const Window = z
  .string()
  .regex(/^\d+[smhd]$/, 'window must be like "30s", "15m", "1h", or "7d"');
export type Window = z.infer<typeof Window>;

/** A relative multiplier, e.g. "3x" (used for price-sanity checks). */
export const Multiplier = z.string().regex(/^\d+(\.\d+)?x$/, 'multiplier must be like "3x"');
export type Multiplier = z.infer<typeof Multiplier>;

/**
 * The set of predicates a rule can test. Multiple predicates in one condition
 * are ANDed together. Each maps to an evaluator in the policy engine.
 */
export const Condition = z
  .object({
    /** Per-transaction amount exceeds this value. */
    amountGt: DecimalString.optional(),
    /** Sum of spend in a rolling window exceeds `gt`. */
    rollingSum: z.object({ window: Window, gt: DecimalString }).optional(),
    /** Transaction count in a rolling window exceeds `gt`. */
    txCount: z.object({ window: Window, gt: z.number().int().nonnegative() }).optional(),
    /** Vendor host matches one of these patterns (supports `*` globs). */
    vendorHostIn: z.array(z.string()).optional(),
    /**
     * Resource PATH matches one of these patterns (supports `*` globs, e.g.
     * "/v1/reports/*"). A full-URL resource is reduced to its pathname before
     * matching (see `resourcePathOf`), so the same pattern works whether the
     * vendor declares "https://api.x.com/v1/answer" or "/v1/answer". Pair
     * with `vendorHostIn` to scope a path rule to specific vendors.
     */
    resourceIn: z.array(z.string()).optional(),
    /** First time Rein has seen this vendor for the agent. */
    vendorFirstSeen: z.boolean().optional(),
    /** Vendor reputation score is below this threshold (Phase 3 hook). */
    vendorReputationLt: z.number().min(0).max(100).optional(),
    /** Amount is more than `gt`-times the observed median for this resource. */
    amountVsResourceMedian: z.object({ gt: Multiplier }).optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), {
    message: 'a condition must specify at least one predicate',
  });
export type Condition = z.infer<typeof Condition>;

/**
 * A single rule: an id plus exactly one action (allow / deny / escalate) whose
 * value is the condition that triggers it.
 */
export const Rule = z
  .object({
    id: z.string().min(1),
    allow: Condition.optional(),
    deny: Condition.optional(),
    escalate: Condition.optional(),
  })
  .refine((r) => [r.allow, r.deny, r.escalate].filter((v) => v !== undefined).length === 1, {
    message: 'a rule must specify exactly one of allow / deny / escalate',
  });
export type Rule = z.infer<typeof Rule>;

export const PolicyDefault = z.enum(['allow', 'deny']);
export type PolicyDefault = z.infer<typeof PolicyDefault>;

export const AppliesTo = z.object({
  /** Agent id patterns (supports `*` globs, e.g. "agt_research_*"). */
  agents: z.array(z.string()).optional(),
  /**
   * Agent label patterns (supports `*` globs) — semantic targeting. Matches
   * when the agent carries at least one label matching any pattern. Requires
   * the agent DOCUMENT: an intent from an unregistered agent never matches a
   * labels-targeted policy (and so fails closed when no other policy applies).
   */
  labels: z.array(z.string()).optional(),
  chains: z.array(Chain).optional(),
});
export type AppliesTo = z.infer<typeof AppliesTo>;

export const Escalation = z.object({
  approvers: z.array(z.string()).default([]),
  timeoutAction: PolicyDefault.default('deny'),
  timeoutMin: z.number().int().positive().default(15),
});
export type Escalation = z.infer<typeof Escalation>;

/**
 * A declarative, versioned, immutable-once-active policy. Evaluation order in
 * the engine is: explicit DENY > ESCALATE > ALLOW > `default`.
 */
export const Policy = z.object({
  policyId: z.string().min(1),
  version: z.string().default('1'),
  appliesTo: AppliesTo.default({}),
  rules: z.array(Rule).default([]),
  default: PolicyDefault.default('deny'),
  /** Below this amount, fail-open is permitted during a policy-service outage. */
  denyFloor: DecimalString.default('0.05'),
  escalation: Escalation.optional(),
});
export type Policy = z.infer<typeof Policy>;
