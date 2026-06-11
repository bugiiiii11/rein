import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { canonicalDecision, newId, type Decision, type DecisionOutcome } from '@rein/core';
import type { MaybePromise } from './stores.js';

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

export interface DecisionLogKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface DecisionLogOptions {
  /** Signing key. Generated per instance when omitted (prod: KMS / @rein/store). */
  keyPair?: DecisionLogKeyPair;
  /**
   * A previously persisted chain to resume, verbatim (entries are already
   * hashed and signed). New appends continue from the last entry's hash, so
   * the chain stays verifiable across restarts — provided `keyPair` is the
   * same key that signed the resumed entries.
   */
  resume?: readonly Decision[];
  /**
   * Durable sink, awaited BEFORE an append is applied or returned: a decision
   * either exists in the store and the chain, or in neither.
   */
  persist?: (decision: Decision) => MaybePromise<void>;
}

/**
 * Append-only, tamper-evident decision log. Each decision is sha256-hashed over
 * its canonical content + the previous hash (a hash chain), then signed with an
 * ed25519 service key. Appends are serialized internally so concurrent calls
 * cannot fork the chain. Verifiable end-to-end via {@link verifyDecisionChain}.
 */
export class DecisionLog {
  private prevHash: string;
  private readonly privateKey: KeyObject;
  readonly publicKeyPem: string;
  private readonly chain: Decision[];
  private readonly persist: ((decision: Decision) => MaybePromise<void>) | undefined;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: DecisionLogOptions = {}) {
    const kp = options.keyPair ?? generateKeyPairSync('ed25519');
    this.privateKey = kp.privateKey;
    this.publicKeyPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    this.chain = [...(options.resume ?? [])];
    this.prevHash = this.chain.at(-1)?.hash ?? 'genesis';
    this.persist = options.persist;
  }

  append(input: DecisionInput): Promise<Decision> {
    const run = this.tail.then(() => this.appendSerialized(input));
    this.tail = run.catch(() => undefined); // a failed append must not wedge the queue
    return run;
  }

  private async appendSerialized(input: DecisionInput): Promise<Decision> {
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
    // Durable first: if the sink throws, neither store nor chain advances.
    if (this.persist) await this.persist(decision);
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
