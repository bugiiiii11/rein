import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { canonicalDecision, newId, type Decision, type DecisionOutcome } from '@rein/core';

export interface DecisionInput {
  intentId: string;
  /** sha256 of the intent's canonical content — binds the decision to the exact transfer. */
  intentHash: string;
  outcome: DecisionOutcome;
  matchedRules: string[];
  reason: string;
  policyId: string;
  policyVersion: string;
  latencyMs: number;
}

/**
 * Append-only, tamper-evident decision log. Each decision is sha256-hashed over
 * its canonical content + the previous hash (a hash chain), then signed with an
 * ed25519 service key. In production the key lives in KMS; here it is generated
 * per instance. Verifiable end-to-end via {@link verifyDecisionChain}.
 */
export class DecisionLog {
  private prevHash = 'genesis';
  private readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  private readonly chain: Decision[] = [];

  constructor(keyPair?: { privateKey: KeyObject; publicKey: KeyObject }) {
    const kp = keyPair ?? generateKeyPairSync('ed25519');
    this.privateKey = kp.privateKey;
    this.publicKeyPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
  }

  append(input: DecisionInput): Decision {
    const decidedAt = new Date();
    const hash = createHash('sha256')
      .update(canonicalDecision({ ...input, prevHash: this.prevHash, decidedAt }))
      .digest('hex');
    const signature = edSign(null, Buffer.from(hash), this.privateKey).toString('base64');

    const decision: Decision = {
      id: newId('dec'),
      intentId: input.intentId,
      intentHash: input.intentHash,
      outcome: input.outcome,
      matchedRules: input.matchedRules,
      reason: input.reason,
      policyId: input.policyId,
      policyVersion: input.policyVersion,
      prevHash: this.prevHash,
      hash,
      signature,
      latencyMs: input.latencyMs,
      decidedAt,
    };
    this.prevHash = hash;
    this.chain.push(decision);
    return decision;
  }

  all(): readonly Decision[] {
    return this.chain;
  }
}

/** Recompute the hash chain and verify every signature. */
export function verifyDecisionChain(
  decisions: readonly Decision[],
  publicKeyPem: string,
): boolean {
  const publicKey = createPublicKey(publicKeyPem);
  let prev = 'genesis';
  for (const d of decisions) {
    if (d.prevHash !== prev) return false;
    const hash = createHash('sha256').update(canonicalDecision(d)).digest('hex');
    if (hash !== d.hash) return false;
    if (!edVerify(null, Buffer.from(d.hash), publicKey, Buffer.from(d.signature, 'base64'))) {
      return false;
    }
    prev = d.hash;
  }
  return true;
}
