import { z } from 'zod';
import { AgentId, ApproverKeyId, DecisionId, IntentId, OrgId } from './ids.js';
import { Asset, Chain } from './chain.js';
import { DecimalString } from './money.js';

/**
 * Human approval of an escalated payment.
 *
 * The load-bearing rule: an approval is a SIGNATURE over the decision, made by
 * a key registered with the engine. The delivery channel (Telegram, email,
 * whatever) is transport, never authority — anyone who compromises the channel
 * gets to show a human a message, not to release funds. There is deliberately
 * no click-to-approve path.
 */

export const ApprovalVerdict = z.enum(['approve', 'reject']);
export type ApprovalVerdict = z.infer<typeof ApprovalVerdict>;

/**
 * `pending` is the only non-terminal state. `expired` is what a TTL lapse
 * converts to — indistinguishable from `rejected` in effect (both deny), but
 * distinguished in the record so "nobody answered" and "somebody said no" stay
 * separable in an audit.
 */
export const ApprovalStatus = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

/**
 * A key whose signature the engine accepts as an approval. Public half only —
 * the private half lives with the human (a hardware token, a laptop, an
 * offline signer) and must never reach the engine.
 */
export const ApproverKey = z.object({
  id: ApproverKeyId,
  orgId: OrgId,
  name: z.string().min(1).max(200),
  /** ed25519 public key, SPKI PEM — the same encoding as the decision log's. */
  publicKey: z.string().min(1),
  algorithm: z.literal('ed25519').default('ed25519'),
  createdAt: z.coerce.date(),
  revokedAt: z.coerce.date().optional(),
});
export type ApproverKey = z.infer<typeof ApproverKey>;

/**
 * A parked escalation: the payment the engine refused to allow on its own
 * authority, held open until a signature arrives or the TTL lapses. Keyed by
 * the escalating decision — one decision, at most one approval request.
 *
 * The payment facts are copied in rather than referenced so the challenge a
 * human sees is self-contained: amount, vendor and resource are exactly what
 * they are being asked to authorize.
 */
export const ApprovalRequest = z.object({
  /** The `escalate` decision this request answers (primary key). */
  decisionId: DecisionId,
  intentId: IntentId,
  /** Binds the approval to the exact transfer — the signed bytes commit to it. */
  intentHash: z.string(),
  agentId: AgentId,
  /**
   * The org the escalating agent belongs to, stamped when the request is
   * parked. ABSENT means the agent was never registered (or the request
   * predates tenancy), and such a request is answerable only by an unscoped
   * operator — there is no org to check an approver against, and guessing one
   * is how a cross-tenant approval happens.
   */
  orgId: OrgId.optional(),
  vendorHost: z.string(),
  resource: z.string(),
  amount: DecimalString,
  asset: Asset,
  chain: Chain,
  /**
   * Task attribution copied from the intent. Carried so an approved payment
   * still counts against its `taskBudget` — an escalation that lost its task
   * id on the way through would make the budget silently under-count exactly
   * the payments a human had to look at.
   */
  taskId: z.string().optional(),
  /** Why policy escalated, verbatim from the decision. */
  reason: z.string(),
  /**
   * Breaker ids whose trip contributed to this escalation. An approval of
   * this request resets exactly these — moving their counting floor to the
   * approval instant — so a human waving one payment through also clears the
   * behavior that stopped it, rather than being asked again immediately.
   * Empty when ordinary rules did the escalating.
   */
  breakers: z.array(z.string()).default([]),
  status: ApprovalStatus,
  createdAt: z.coerce.date(),
  /** Past this instant the request denies, whatever arrives afterwards. */
  expiresAt: z.coerce.date(),
  resolvedAt: z.coerce.date().optional(),
  /** Which registered key signed — absent when the TTL lapsed instead. */
  approverKeyId: ApproverKeyId.optional(),
  /**
   * The follow-up decision appended to the chain when this resolved. That
   * decision, not this record, is the voucher a signer verifies: the original
   * `escalate` decision is never rewritten.
   */
  finalDecisionId: DecisionId.optional(),
});
export type ApprovalRequest = z.infer<typeof ApprovalRequest>;

/** The two byte-strings an approver may sign for a given request. */
export const ApprovalChallenges = z.object({
  approve: z.string(),
  reject: z.string(),
});
export type ApprovalChallenges = z.infer<typeof ApprovalChallenges>;

/**
 * A signed verdict, submitted to the engine by anyone (the signature is the
 * authority, so the carrier does not matter). `signature` is base64 ed25519
 * over `canonicalApproval({ decisionId, intentHash, verdict })`.
 */
export const ApprovalGrant = z.object({
  decisionId: DecisionId,
  intentHash: z.string(),
  verdict: ApprovalVerdict,
  approverKeyId: ApproverKeyId,
  signature: z.string().min(1),
});
export type ApprovalGrant = z.infer<typeof ApprovalGrant>;

/** Terminal statuses — a request in one of these will never change again. */
export function isResolved(status: ApprovalStatus): boolean {
  return status !== 'pending';
}
