import { z } from 'zod';
import { Chain } from './chain.js';
import { OrgId } from './ids.js';
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
    /**
     * Cumulative spend attributed to THIS intent's `taskContext.taskId`
     * (prior spend on the task plus this payment) exceeds `gt`. Scopes a
     * budget to one unit of work rather than to a window: a research run that
     * is meant to cost a dollar cannot quietly cost fifty, however slowly.
     *
     * An intent carrying no `taskId` cannot be attributed to a task, so the
     * predicate never triggers for one. Requiring attribution is a separate,
     * deliberate rule (deny on `taskIdMissing`), not a side effect of setting
     * a budget — otherwise every untagged probe payment would trip every
     * task budget in the policy.
     */
    taskBudget: z.object({ gt: DecimalString }).optional(),
    /** The intent carries no `taskContext.taskId` (or an empty one). */
    taskIdMissing: z.boolean().optional(),
  })
  .refine((c) => Object.values(c).some((v) => v !== undefined), {
    message: 'a condition must specify at least one predicate',
  });
export type Condition = z.infer<typeof Condition>;

/**
 * A behavioral circuit breaker: one primitive with three tripwires — a window
 * (rate), a transaction count, and a value cap — measured over the agent's
 * own recent activity.
 *
 * A breaker is not a rule. Rules ask about the intent in front of them; a
 * breaker asks whether the agent's BEHAVIOR has left the envelope it was
 * given, and once it has, every subsequent intent ESCALATES for a signed
 * approval. It never denies on its own: an agent that trips a breaker in the
 * middle of a job must be able to be waved through by a human, because a
 * silent deny at the wrong moment strands the work with no path forward and
 * no one told (the failure mode Flash's exit paths taught).
 *
 * Reset happens two ways, and they are one mechanism: the window rolling
 * forward, or a signed approval, which moves the breaker's counting floor to
 * now. Nothing "un-trips" a breaker by decree — the activity simply stops
 * being inside the measured span.
 *
 * Targeting is the policy's job: `appliesTo.agents` / `appliesTo.labels`
 * decide WHICH agents carry the breaker. COUNTING is always per agent — a
 * breaker pooled across every agent sharing a label needs a cross-agent
 * aggregate the per-agent spend context cannot express, and is deferred.
 */
export const Breaker = z
  .object({
    id: z.string().min(1),
    /** The trailing span the tripwires measure over. */
    window: Window,
    /**
     * Trip when the window would hold MORE than this many transactions.
     * `10` permits ten in the window and escalates the eleventh.
     */
    txCount: z.number().int().positive().optional(),
    /**
     * Trip when the window's spend would exceed this total. `"50.00"` permits
     * a window totalling exactly 50.00 and escalates the payment that would
     * carry it past. Prospective, like every other spend predicate: the
     * payment that would breach the cap is the one that escalates, rather
     * than the innocent one after it.
     */
    valueCap: DecimalString.optional(),
  })
  .refine((b) => b.txCount !== undefined || b.valueCap !== undefined, {
    message: 'a breaker must specify at least one of txCount / valueCap',
  });
export type Breaker = z.infer<typeof Breaker>;

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
  /**
   * The org this policy governs. ABSENT means GLOBAL — it is considered for
   * every agent, which is what every policy written before tenancy existed is
   * and stays.
   *
   * This is separate from {@link AppliesTo} on purpose, and it has to be:
   * `appliesTo: {}` matches every agent, so a tenant's policy carrying the
   * default targeting would otherwise govern other tenants' agents the moment
   * it was written. Org scoping is applied BEFORE targeting — a policy whose
   * `orgId` is not the agent's org is not a candidate at all.
   */
  orgId: OrgId.optional(),
  appliesTo: AppliesTo.default({}),
  rules: z.array(Rule).default([]),
  /**
   * Behavioral breakers evaluated alongside the rules. A tripped breaker
   * escalates at the same precedence as an `escalate` rule — so an explicit
   * DENY still wins, and an ALLOW rule cannot wave past a tripped breaker.
   */
  breakers: z.array(Breaker).default([]),
  default: PolicyDefault.default('deny'),
  /** Below this amount, fail-open is permitted during a policy-service outage. */
  denyFloor: DecimalString.default('0.05'),
  escalation: Escalation.optional(),
});
export type Policy = z.infer<typeof Policy>;
