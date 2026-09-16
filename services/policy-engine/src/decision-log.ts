import {
  createHash,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  createPublicKey,
  type KeyObject,
} from 'node:crypto';
import { canonicalDecision, newId, type Decision, type DecisionOutcome } from '@reinconsole/core';
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
  /**
   * Which agent this decision was about — SIDECAR attribution, never part of
   * the decision itself.
   *
   * A `Decision` has no `agentId` and `canonicalDecision` hashes a fixed field
   * set, so adding one to the record would either be invisible to the
   * signature (an unauthenticated field on an authenticated record) or would
   * change the canonical bytes and invalidate every chain already on disk.
   * The log keeps the mapping beside the chain instead, and the store persists
   * it as a column. Tenant-scoped reads need it: without attribution, "show me
   * my org's decisions" has no answer to filter on.
   */
  agentId?: string;
}

export interface DecisionLogKeyPair {
  privateKey: KeyObject;
  publicKey: KeyObject;
}

export interface DecisionLogOptions {
  /** Signing key. Generated per instance when omitted (prod: KMS / @reinconsole/store). */
  keyPair?: DecisionLogKeyPair;
  /**
   * A previously persisted chain to resume, verbatim (entries are already
   * hashed and signed). New appends continue from the last entry's hash, so
   * the chain stays verifiable across restarts — provided `keyPair` is the
   * same key that signed the resumed entries.
   */
  resume?: readonly Decision[];
  /**
   * Sidecar attribution for the resumed chain: decision id -> agent id. A
   * decision missing from this map is UNATTRIBUTED — it predates the column,
   * and a scoped reader is shown none of them rather than all of them.
   */
  attribution?: Readonly<Record<string, string>>;
  /**
   * Durable sink, awaited BEFORE an append is applied or returned: a decision
   * either exists in the store and the chain, or in neither. `agentId` is the
   * sidecar attribution (see {@link DecisionInput.agentId}) — it is stored
   * beside the row, never inside the signed document.
   */
  persist?: (decision: Decision, agentId?: string) => MaybePromise<void>;
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
  private readonly persist:
    | ((decision: Decision, agentId?: string) => MaybePromise<void>)
    | undefined;
  /** Sidecar attribution — see {@link DecisionInput.agentId}. */
  private readonly agentByDecision = new Map<string, string>();
  private readonly agentByIntent = new Map<string, string>();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(options: DecisionLogOptions = {}) {
    const kp = options.keyPair ?? generateKeyPairSync('ed25519');
    this.privateKey = kp.privateKey;
    this.publicKeyPem = kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    this.chain = [...(options.resume ?? [])];
    this.prevHash = this.chain.at(-1)?.hash ?? 'genesis';
    this.persist = options.persist;
    for (const decision of this.chain) {
      const agentId = options.attribution?.[decision.id];
      if (agentId !== undefined) this.attribute(decision, agentId);
    }
  }

  private attribute(decision: Pick<Decision, 'id' | 'intentId'>, agentId: string): void {
    this.agentByDecision.set(decision.id, agentId);
    // One intent can be judged twice — an escalation and the decision that
    // releases it — and both are the same agent's, so last write is the same
    // answer as first.
    this.agentByIntent.set(decision.intentId, agentId);
  }

  /** The agent a decision was about, or undefined if it was never attributed. */
  agentOf(decisionId: string): string | undefined {
    return this.agentByDecision.get(decisionId);
  }

  /**
   * The agent an intent belongs to, via the decisions that judged it. This is
   * the ownership test for anything keyed by intent — a settlement report, for
   * one, which names an intent and nothing else.
   */
  agentForIntent(intentId: string): string | undefined {
    return this.agentByIntent.get(intentId);
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
    // Durable first: if the sink throws, neither store nor chain advances —
    // and the attribution advances with the chain, never ahead of it.
    if (this.persist) await this.persist(decision, input.agentId);
    this.prevHash = hash;
    this.chain.push(decision);
    if (input.agentId !== undefined) this.attribute(decision, input.agentId);
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
