import {
  type Agent,
  type Policy,
  type PaymentIntent,
  type Condition,
  type DecisionOutcome,
  type Window,
  gt,
  sumDecimal,
  mulDecimal,
  globMatchAny,
  resourcePathOf,
} from '@reinconsole/core';

/**
 * The data the evaluator needs about an agent's history to test predicates.
 * Resolved synchronously per intent (in-memory today; pre-resolved from the
 * DB/Timescale continuous aggregates in production). All sums/counts reflect
 * PRIOR activity — the evaluator adds the current intent itself.
 */
export interface SpendContext {
  rollingSum(window: Window): string;
  txCount(window: Window): number;
  isVendorFirstSeen(host: string): boolean;
  vendorReputation(host: string): number | undefined;
  resourceMedian(resource: string): string | undefined;
}

export interface EvaluationResult {
  outcome: DecisionOutcome;
  matchedRules: string[];
  reason: string;
  policyId: string;
  policyVersion: string;
}

/**
 * The slice of the agent document label targeting needs. Optional at every
 * seam: when the document is unknown (unregistered agent), a labels-targeted
 * policy simply never applies — which fails closed downstream when no other
 * policy picks the intent up.
 */
export type AgentFacts = Pick<Agent, 'labels'>;

/** Does this policy target the given intent's agent (id + labels) + chain? */
export function policyApplies(policy: Policy, intent: PaymentIntent, agent?: AgentFacts): boolean {
  const { agents, labels, chains } = policy.appliesTo;
  if (chains && !chains.includes(intent.chain)) return false;
  if (agents && agents.length > 0 && !globMatchAny(agents, intent.agentId)) return false;
  if (labels && labels.length > 0) {
    if (!agent?.labels.some((label) => globMatchAny(labels, label))) return false;
  }
  return true;
}

/**
 * Evaluate a single condition. All present predicates are ANDed. This is the
 * sandbox boundary: only these typed predicates exist — there is no arbitrary
 * code execution from policy input.
 */
export function conditionMatches(
  cond: Condition,
  intent: PaymentIntent,
  ctx: SpendContext,
): boolean {
  if (cond.amountGt !== undefined && !gt(intent.amount, cond.amountGt)) return false;

  if (cond.rollingSum) {
    // Prospective: prior spend in window + this payment.
    const prospective = sumDecimal([ctx.rollingSum(cond.rollingSum.window), intent.amount]);
    if (!gt(prospective, cond.rollingSum.gt)) return false;
  }

  if (cond.txCount) {
    const prospective = ctx.txCount(cond.txCount.window) + 1;
    if (prospective <= cond.txCount.gt) return false;
  }

  if (cond.vendorHostIn && !globMatchAny(cond.vendorHostIn, intent.vendor.host)) return false;

  // Patterns are path globs; a vendor-declared full-URL resource is reduced
  // to its pathname first so both shapes match identically.
  if (cond.resourceIn && !globMatchAny(cond.resourceIn, resourcePathOf(intent.resource))) {
    return false;
  }

  if (
    cond.vendorFirstSeen !== undefined &&
    ctx.isVendorFirstSeen(intent.vendor.host) !== cond.vendorFirstSeen
  ) {
    return false;
  }

  if (cond.vendorReputationLt !== undefined) {
    const rep = ctx.vendorReputation(intent.vendor.host);
    // No reputation data => indeterminate => do not trigger (avoid unfair freeze).
    if (rep === undefined || !(rep < cond.vendorReputationLt)) return false;
  }

  if (cond.amountVsResourceMedian) {
    const med = ctx.resourceMedian(intent.resource);
    if (med === undefined) return false;
    const factor = cond.amountVsResourceMedian.gt.replace(/x$/, '');
    if (!gt(intent.amount, mulDecimal(med, factor))) return false;
  }

  return true;
}

function actionOf(rule: Policy['rules'][number]): { action: DecisionOutcome; cond: Condition } {
  if (rule.deny) return { action: 'deny', cond: rule.deny };
  if (rule.escalate) return { action: 'escalate', cond: rule.escalate };
  return { action: 'allow', cond: rule.allow as Condition };
}

/**
 * Evaluate an intent against the applicable policies.
 *
 * Precedence (per the technical doc §3.3): explicit DENY > ESCALATE > ALLOW >
 * policy default. v0.1 selects the FIRST applicable policy (deterministic by
 * insertion order); overlapping-policy merge is a documented future item. When
 * no policy applies, we fail closed (deny).
 */
export function evaluate(
  intent: PaymentIntent,
  policies: readonly Policy[],
  ctx: SpendContext,
  agent?: AgentFacts,
): EvaluationResult {
  const policy = policies.find((p) => policyApplies(p, intent, agent));
  if (!policy) {
    return {
      outcome: 'deny',
      matchedRules: [],
      reason: 'no applicable policy (fail-closed default)',
      policyId: 'none',
      policyVersion: '0',
    };
  }

  const denies: string[] = [];
  const escalates: string[] = [];
  const allows: string[] = [];

  for (const rule of policy.rules) {
    const { action, cond } = actionOf(rule);
    if (!conditionMatches(cond, intent, ctx)) continue;
    if (action === 'deny') denies.push(rule.id);
    else if (action === 'escalate') escalates.push(rule.id);
    else allows.push(rule.id);
  }

  const base = { policyId: policy.policyId, policyVersion: policy.version };
  if (denies.length > 0) {
    return { outcome: 'deny', matchedRules: denies, reason: `denied by: ${denies.join(', ')}`, ...base };
  }
  if (escalates.length > 0) {
    return {
      outcome: 'escalate',
      matchedRules: escalates,
      reason: `escalated by: ${escalates.join(', ')}`,
      ...base,
    };
  }
  if (allows.length > 0) {
    return { outcome: 'allow', matchedRules: allows, reason: `allowed by: ${allows.join(', ')}`, ...base };
  }
  return {
    outcome: policy.default,
    matchedRules: [],
    reason: `no rule matched; policy default = ${policy.default}`,
    ...base,
  };
}
