import { createHash, verify as edVerify, type KeyObject } from 'node:crypto';
import {
  canonicalDecision,
  canonicalIntent,
  type Decision,
  type PaymentIntent,
} from '@reinconsole/core';

/** sha256 hex of an intent's canonical content — must equal `Decision.intentHash`. */
export function intentHashOf(intent: PaymentIntent): string {
  return createHash('sha256').update(canonicalIntent(intent)).digest('hex');
}

export type VoucherCheck = { ok: true } | { ok: false; reason: string };

/**
 * Verify an {intent, decision} pair as a self-contained spend voucher, fully
 * offline: the decision must reference this intent by id, commit to its exact
 * content via intentHash, hash to its own canonical content, and carry a valid
 * engine signature over that hash. Anything an agent tampers with — amount,
 * recipient, outcome — breaks one of these links.
 */
export function verifyVoucher(
  intent: PaymentIntent,
  decision: Decision,
  enginePublicKey: KeyObject,
): VoucherCheck {
  if (decision.intentId !== intent.id) {
    return { ok: false, reason: 'decision references a different intent' };
  }
  if (decision.intentHash !== intentHashOf(intent)) {
    return { ok: false, reason: 'intent content does not match what the decision signed' };
  }
  const hash = createHash('sha256').update(canonicalDecision(decision)).digest('hex');
  if (hash !== decision.hash) {
    return { ok: false, reason: 'decision hash does not match its content' };
  }
  const signatureOk = edVerify(
    null,
    Buffer.from(decision.hash),
    enginePublicKey,
    Buffer.from(decision.signature, 'base64'),
  );
  if (!signatureOk) {
    return { ok: false, reason: 'decision signature does not verify against the engine key' };
  }
  return { ok: true };
}
