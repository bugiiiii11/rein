import {
  createPrivateKey,
  createPublicKey,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import {
  ApproverKey,
  ApprovalRequest,
  canonicalApproval,
  newId,
  type ApprovalChallenges,
  type ApprovalContent,
  type ApprovalGrant,
  type ApprovalVerdict,
  type Decision,
  type PaymentIntent,
} from '@reinconsole/core';
import type { MaybePromise } from './stores.js';

/**
 * Human-in-the-loop approvals for escalated payments.
 *
 * The authority model, which everything here exists to enforce: an approval is
 * a SIGNATURE over the decision, produced by a key registered with the engine.
 * A delivery channel is transport — it tells a human that a decision is
 * waiting and hands them the exact bytes to sign. Compromising the channel
 * gets an attacker the ability to show someone a message; it does not move
 * money, because the channel is never asked to assert a verdict. There is no
 * click-to-approve path anywhere in this file, and there must not be one.
 */

/** How long a parked escalation stays answerable before it denies. */
export const DEFAULT_ESCALATION_TTL_MS = 600_000; // 10 min

export type ApprovalFailureCode =
  | 'unknown_request'
  | 'already_resolved'
  | 'request_expired'
  | 'unknown_approver'
  | 'approver_revoked'
  | 'intent_hash_mismatch'
  | 'bad_signature';

/** A refused approval submission. Fails closed: the request stays pending. */
export class ApprovalError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    readonly code: ApprovalFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'ApprovalError';
  }
}

/**
 * Persistence seam. Approvals are authority state (like signer sessions and
 * revocations), so both writes are persist-then-cache: awaited before the
 * service treats a key as registered or a request as parked/resolved.
 */
export interface ApprovalStorePort {
  putApprover(key: ApproverKey): MaybePromise<void>;
  getApprover(id: string): ApproverKey | undefined;
  listApprovers(): ApproverKey[];
  putRequest(request: ApprovalRequest): MaybePromise<void>;
  getRequest(decisionId: string): ApprovalRequest | undefined;
  listRequests(): ApprovalRequest[];
}

export class InMemoryApprovalStore implements ApprovalStorePort {
  private readonly approvers = new Map<string, ApproverKey>();
  private readonly requests = new Map<string, ApprovalRequest>();

  putApprover(key: ApproverKey): void {
    this.approvers.set(key.id, key);
  }

  getApprover(id: string): ApproverKey | undefined {
    return this.approvers.get(id);
  }

  listApprovers(): ApproverKey[] {
    return [...this.approvers.values()];
  }

  putRequest(request: ApprovalRequest): void {
    this.requests.set(request.decisionId, request);
  }

  getRequest(decisionId: string): ApprovalRequest | undefined {
    return this.requests.get(decisionId);
  }

  listRequests(): ApprovalRequest[] {
    return [...this.requests.values()];
  }
}

/**
 * Where a challenge is delivered. Implementations carry NO authority: they are
 * handed a request and the bytes to sign, and their reply is never read back.
 * A channel that throws is logged and ignored — a delivery failure must not
 * turn a parked escalation into an allow.
 */
export interface ApprovalChannel {
  readonly name: string;
  deliver(request: ApprovalRequest, challenges: ApprovalChallenges): MaybePromise<void>;
}

export interface ApprovalServiceOptions {
  store?: ApprovalStorePort;
  channels?: ApprovalChannel[];
  /** Time a request stays answerable. Expiry denies (fail closed). */
  ttlMs?: number;
  /** Injected clock, so TTL behaviour is testable without waiting. */
  now?: () => number;
  /** Called when a channel throws, so delivery failures are not silent. */
  onDeliveryError?: (channel: string, error: unknown) => void;
}

/** The verified-but-not-yet-committed result of a grant submission. */
export interface VerifiedGrant {
  request: ApprovalRequest;
  approver: ApproverKey;
  verdict: ApprovalVerdict;
}

export class ApprovalService {
  private readonly store: ApprovalStorePort;
  private readonly channels: ApprovalChannel[];
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly onDeliveryError: ((channel: string, error: unknown) => void) | undefined;

  constructor(options: ApprovalServiceOptions = {}) {
    this.store = options.store ?? new InMemoryApprovalStore();
    this.channels = options.channels ?? [];
    this.ttlMs = options.ttlMs ?? DEFAULT_ESCALATION_TTL_MS;
    this.now = options.now ?? Date.now;
    this.onDeliveryError = options.onDeliveryError;
  }

  // --- Approver keys ---

  async registerApprover(input: {
    orgId: string;
    name: string;
    publicKey: string;
  }): Promise<ApproverKey> {
    // Parse the key material now: a malformed PEM must fail at registration,
    // not at 3am when someone is trying to approve a payment.
    assertEd25519PublicKey(input.publicKey);
    const key = ApproverKey.parse({
      id: newId('apk'),
      orgId: input.orgId,
      name: input.name,
      publicKey: input.publicKey,
      algorithm: 'ed25519',
      createdAt: new Date(this.now()),
    });
    await this.store.putApprover(key);
    return key;
  }

  async revokeApprover(id: string): Promise<ApproverKey | undefined> {
    const key = this.store.getApprover(id);
    if (!key) return undefined;
    const revoked: ApproverKey = { ...key, revokedAt: new Date(this.now()) };
    await this.store.putApprover(revoked);
    return revoked;
  }

  listApprovers(): ApproverKey[] {
    return this.store.listApprovers();
  }

  /** True once a key exists that could actually answer a challenge. */
  hasActiveApprover(): boolean {
    return this.store.listApprovers().some((k) => k.revokedAt === undefined);
  }

  // --- Requests ---

  /**
   * Park an escalated decision. Delivery happens after the record is durable,
   * so a channel can never announce a challenge the engine has not stored.
   */
  async open(intent: PaymentIntent, decision: Decision): Promise<ApprovalRequest> {
    const createdAt = new Date(this.now());
    const request = ApprovalRequest.parse({
      decisionId: decision.id,
      intentId: intent.id,
      intentHash: decision.intentHash,
      agentId: intent.agentId,
      vendorHost: intent.vendor.host,
      resource: intent.resource,
      amount: intent.amount,
      asset: intent.asset,
      chain: intent.chain,
      reason: decision.reason ?? 'escalated',
      status: 'pending',
      createdAt,
      expiresAt: new Date(this.now() + this.ttlMs),
    });
    await this.store.putRequest(request);
    await this.deliver(request);
    return request;
  }

  get(decisionId: string): ApprovalRequest | undefined {
    return this.store.getRequest(decisionId);
  }

  list(): ApprovalRequest[] {
    return this.store.listRequests();
  }

  /** Still answerable right now — parked, and inside its TTL. */
  pending(): ApprovalRequest[] {
    const at = this.now();
    return this.store
      .listRequests()
      .filter((r) => r.status === 'pending' && r.expiresAt.getTime() > at);
  }

  /**
   * Parked requests whose TTL has lapsed. The caller (the engine) converts
   * each to a deny — expiry is a denial, never a quiet drop.
   */
  lapsed(now: number = this.now()): ApprovalRequest[] {
    return this.store
      .listRequests()
      .filter((r) => r.status === 'pending' && r.expiresAt.getTime() <= now);
  }

  /** The two byte-strings that mean something for this request. */
  challengesFor(request: Pick<ApprovalRequest, 'decisionId' | 'intentHash'>): ApprovalChallenges {
    const base = { decisionId: request.decisionId, intentHash: request.intentHash };
    return {
      approve: canonicalApproval({ ...base, verdict: 'approve' }),
      reject: canonicalApproval({ ...base, verdict: 'reject' }),
    };
  }

  /**
   * Check a submitted grant end to end without committing anything. Every
   * failure throws; a caller that gets a result has a signature it can act on.
   *
   * Order matters: cheap state checks first, cryptography last, so a flood of
   * junk submissions cannot be used to burn CPU on signature verification.
   */
  verify(grant: ApprovalGrant): VerifiedGrant {
    const request = this.store.getRequest(grant.decisionId);
    if (!request) {
      throw new ApprovalError(404, 'unknown_request', `no escalation for ${grant.decisionId}`);
    }
    if (request.status !== 'pending') {
      throw new ApprovalError(409, 'already_resolved', `escalation already ${request.status}`);
    }
    if (request.expiresAt.getTime() <= this.now()) {
      throw new ApprovalError(409, 'request_expired', 'escalation expired; it denies');
    }
    if (grant.intentHash !== request.intentHash) {
      // The signature covers the hash the submitter sent. If that is not the
      // hash the engine parked, they signed a different payment.
      throw new ApprovalError(400, 'intent_hash_mismatch', 'intentHash does not match the request');
    }

    const approver = this.store.getApprover(grant.approverKeyId);
    if (!approver) {
      throw new ApprovalError(404, 'unknown_approver', `no such approver key: ${grant.approverKeyId}`);
    }
    if (approver.revokedAt) {
      throw new ApprovalError(409, 'approver_revoked', 'approver key has been revoked');
    }

    const content: ApprovalContent = {
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict: grant.verdict,
    };
    if (!verifyApproval(approver.publicKey, content, grant.signature)) {
      throw new ApprovalError(400, 'bad_signature', 'approval signature does not verify');
    }

    return { request, approver, verdict: grant.verdict };
  }

  /**
   * Write the terminal record. Called by the engine AFTER the follow-up
   * decision is on the chain, so a resolved request always names a decision
   * that exists.
   */
  async settle(
    decisionId: string,
    outcome: {
      status: 'approved' | 'rejected' | 'expired';
      finalDecisionId: string;
      approverKeyId?: string;
    },
  ): Promise<ApprovalRequest> {
    const request = this.store.getRequest(decisionId);
    if (!request) {
      throw new ApprovalError(404, 'unknown_request', `no escalation for ${decisionId}`);
    }
    const settled: ApprovalRequest = {
      ...request,
      status: outcome.status,
      resolvedAt: new Date(this.now()),
      finalDecisionId: outcome.finalDecisionId,
      ...(outcome.approverKeyId ? { approverKeyId: outcome.approverKeyId } : {}),
    };
    await this.store.putRequest(settled);
    return settled;
  }

  private async deliver(request: ApprovalRequest): Promise<void> {
    const challenges = this.challengesFor(request);
    for (const channel of this.channels) {
      try {
        await channel.deliver(request, challenges);
      } catch (error) {
        // A channel that is down must not decide a payment. The request stays
        // parked and will expire into a deny if nobody answers.
        this.onDeliveryError?.(channel.name, error);
      }
    }
  }
}

// --- Signing helpers (offline side) ---

/**
 * Produce an approval signature. This runs where the private key lives — a
 * laptop, a hardware token, an air-gapped box — never inside the engine. It is
 * exported so the CLI, tests, and an operator's own script all sign identical
 * bytes.
 */
export function signApproval(
  privateKey: KeyObject | string,
  content: ApprovalContent,
): string {
  const key = typeof privateKey === 'string' ? createPrivateKey(privateKey) : privateKey;
  return edSign(null, Buffer.from(canonicalApproval(content)), key).toString('base64');
}

/** Verify an approval signature against a registered approver's public key. */
export function verifyApproval(
  publicKeyPem: string,
  content: ApprovalContent,
  signature: string,
): boolean {
  try {
    return edVerify(
      null,
      Buffer.from(canonicalApproval(content)),
      createPublicKey(publicKeyPem),
      Buffer.from(signature, 'base64'),
    );
  } catch {
    // Malformed key or signature encoding — not a valid approval.
    return false;
  }
}

function assertEd25519PublicKey(pem: string): void {
  let key: KeyObject;
  try {
    key = createPublicKey(pem);
  } catch (error) {
    throw new TypeError(
      `approver publicKey is not a readable PEM key: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(`approver publicKey must be ed25519, got ${String(key.asymmetricKeyType)}`);
  }
}
