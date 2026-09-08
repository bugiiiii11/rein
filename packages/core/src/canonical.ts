import type { PaymentIntent } from './intent.js';
import type { DecisionOutcome } from './decision.js';
import type { ApprovalVerdict } from './approval.js';

/**
 * Canonical byte forms shared by the policy engine (which hashes and signs
 * them) and the signer (which verifies them offline). Field order is fixed,
 * dates are ISO strings, and absent optionals are explicit nulls, so the same
 * parsed object always canonicalizes to the same bytes — including after a
 * JSON round-trip over HTTP.
 *
 * These builders are pure (no node:crypto) so @reinconsole/core stays loadable in a
 * browser; services hash the strings with whatever sha256 they have.
 */

/** Canonical form of an intent — what `Decision.intentHash` commits to. */
export function canonicalIntent(intent: PaymentIntent): string {
  return JSON.stringify({
    id: intent.id,
    agentId: intent.agentId,
    vendor: {
      host: intent.vendor.host,
      address: intent.vendor.address,
      erc8004Id: intent.vendor.erc8004Id ?? null,
    },
    resource: intent.resource,
    amount: intent.amount,
    asset: intent.asset,
    chain: intent.chain,
    taskContext: {
      taskId: intent.taskContext.taskId ?? null,
      parentRunId: intent.taskContext.parentRunId ?? null,
      purpose: intent.taskContext.purpose ?? null,
    },
    nonce: intent.nonce,
    createdAt: intent.createdAt.toISOString(),
  });
}

/** The decision fields covered by `Decision.hash` (and thus its signature). */
export interface DecisionContent {
  intentId: string;
  intentHash: string;
  outcome: DecisionOutcome;
  matchedRules: string[];
  policyId: string;
  policyVersion: string;
  prevHash: string;
  decidedAt: Date;
}

/** Canonical form of a decision — what `Decision.hash` is computed over. */
export function canonicalDecision(d: DecisionContent): string {
  return JSON.stringify({
    intentId: d.intentId,
    intentHash: d.intentHash,
    outcome: d.outcome,
    matchedRules: d.matchedRules,
    policyId: d.policyId,
    policyVersion: d.policyVersion,
    prevHash: d.prevHash,
    decidedAt: d.decidedAt.toISOString(),
  });
}

/** The fields an approval signature commits to. */
export interface ApprovalContent {
  decisionId: string;
  intentHash: string;
  verdict: ApprovalVerdict;
}

/**
 * Canonical form of an approval — the exact bytes an approver signs.
 *
 * Three properties are deliberate. The leading `rein` domain tag separates
 * this signature space from the decision log's, so a decision signature can
 * never be replayed as an approval or the reverse. `decisionId` makes each
 * challenge single-use: one escalation, one decision id, one signature that
 * means anything. And `verdict` is INSIDE the signed bytes — without it, a
 * captured approval could be resubmitted as a rejection (or vice versa) by
 * anyone who saw it in flight.
 */
export function canonicalApproval(a: ApprovalContent): string {
  return JSON.stringify({
    rein: 'approval/v1',
    decisionId: a.decisionId,
    intentHash: a.intentHash,
    verdict: a.verdict,
  });
}
