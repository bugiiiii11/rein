import { EventEmitter } from 'node:events';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { privateKeyToAccount } from 'viem/accounts';
import type { Hex, LocalAccount } from 'viem';
import {
  compareDecimal,
  gt,
  sumDecimal,
  type Asset,
  type Decision,
  type PaymentIntent,
  type ReinEvent,
  type Session,
} from '@rein/core';
import {
  atomicToDecimal,
  networkToChain,
  requirementDecimals,
  resolveAsset,
  type PaymentRequirement,
} from '@rein/sdk';
import {
  chainIdForNetwork,
  encodePaymentHeader,
  intentNonce,
  transferWithAuthorizationTypes,
  type ExactEvmAuthorization,
} from '@rein/x402-rails';
import { SignerError, type RefusalCode } from './errors.js';
import { SessionStore, sessionState, type CreateSessionInput, type CreatedSession } from './sessions.js';
import { verifyVoucher } from './verify.js';

export interface SessionSignerOptions {
  /** The policy engine's decision-verification key (PEM), pinned at boot. */
  enginePublicKeyPem: string;
  /** Reject vouchers older than this — agents cannot hoard allows. Default 300s. */
  maxDecisionAgeSeconds?: number;
  /** How far into the past validAfter reaches, absorbing clock skew. */
  validAfterSkewSeconds?: number;
  /** validBefore window when the requirement omits maxTimeoutSeconds. */
  defaultTimeoutSeconds?: number;
  /** Extra token-address -> symbol mappings, mirroring the guard's option. */
  assetAddresses?: Record<string, Asset>;
  /** Injectable ms clock for deterministic tests. */
  now?: () => number;
}

/** What the agent side sends: the 402 offer plus the engine-signed voucher. */
export interface SignRequest {
  sessionToken: string;
  requirement: PaymentRequirement;
  intent: PaymentIntent;
  decision: Decision;
}

export interface SignResult {
  /** Ready-made X-PAYMENT header value (x402 v1 exact-EVM). */
  paymentHeader: string;
  /** The wallet address the signature spends from. */
  from: string;
  authorization: ExactEvmAuthorization;
}

/**
 * The session-key signer: Rein's custody tier. Wallet keys live here and only
 * here — agent processes get a session token, and every EIP-3009 signature is
 * released against an engine-signed allow voucher for the exact transfer being
 * signed, once, under the session's caps. Where SDK mode *detects* bypass
 * (shadow.spend), this tier *prevents* it: there is no key to go rogue with.
 */
export class SessionSigner {
  private readonly enginePublicKey: KeyObject;
  private readonly store: SessionStore;
  private readonly wallets = new Map<string, LocalAccount>();
  private readonly usedDecisions = new Set<string>();
  private readonly bus = new EventEmitter();
  private readonly maxDecisionAgeMs: number;
  private readonly skewSeconds: number;
  private readonly defaultTimeoutSeconds: number;
  private readonly assetAddresses: Record<string, Asset>;
  private readonly now: () => number;

  constructor(options: SessionSignerOptions) {
    this.enginePublicKey = createPublicKey(options.enginePublicKeyPem);
    this.maxDecisionAgeMs = (options.maxDecisionAgeSeconds ?? 300) * 1000;
    this.skewSeconds = options.validAfterSkewSeconds ?? 600;
    this.defaultTimeoutSeconds = options.defaultTimeoutSeconds ?? 300;
    this.assetAddresses = options.assetAddresses ?? {};
    this.now = options.now ?? (() => Date.now());
    this.store = new SessionStore(this.now);
  }

  onEvent(handler: (event: ReinEvent) => void): void {
    this.bus.on('event', handler);
  }

  private emit(event: ReinEvent): void {
    this.bus.emit('event', event);
  }

  /** Take custody of an agent's wallet key. Returns the wallet address. */
  registerWallet(agentId: string, privateKey: Hex): string {
    const account = privateKeyToAccount(privateKey);
    this.wallets.set(agentId, account);
    return account.address;
  }

  walletAddress(agentId: string): string | undefined {
    return this.wallets.get(agentId)?.address;
  }

  createSession(input: CreateSessionInput): CreatedSession {
    return this.store.create(input);
  }

  revokeSession(id: string): void {
    this.store.revoke(id);
  }

  sessions(): readonly Session[] {
    return this.store.list();
  }

  /** Cumulative amount a session has released signatures for. */
  sessionSpent(id: string): string {
    return this.store.spent(id);
  }

  /**
   * The gate. Refusals throw {@link SignerError} and emit `signature.refused`;
   * a release emits `signature.released`. Check order matters: cheapest and
   * least-trusting first, the key touched last.
   */
  async sign(request: SignRequest): Promise<SignResult> {
    const { requirement, intent, decision } = request;

    const session = this.store.findByToken(request.sessionToken);
    if (!session) {
      throw this.refuse('session_unknown', 'no session matches this token', {
        agentId: intent.agentId,
        intentId: intent.id,
      });
    }

    const ctx = { sessionId: session.id, agentId: intent.agentId, intentId: intent.id };
    const state = sessionState(session, this.now());
    if (state === 'revoked') throw this.refuse('session_revoked', 'session has been revoked', ctx);
    if (state === 'expired') throw this.refuse('session_expired', 'session has expired', ctx);

    if (intent.agentId !== session.agentId) {
      throw this.refuse(
        'agent_mismatch',
        `session belongs to ${session.agentId}, not ${intent.agentId}`,
        ctx,
      );
    }

    const account = this.wallets.get(session.agentId);
    if (!account) {
      throw this.refuse('no_wallet', `no wallet in custody for ${session.agentId}`, ctx);
    }

    const voucher = verifyVoucher(intent, decision, this.enginePublicKey);
    if (!voucher.ok) throw this.refuse('voucher_invalid', voucher.reason, ctx);

    // From here on the voucher is authentic — the engine really judged this
    // exact intent. What remains is whether it authorizes THIS signature.
    if (decision.outcome !== 'allow') {
      throw this.refuse(
        'not_allowed',
        `decision outcome is "${decision.outcome}"${decision.reason ? `: ${decision.reason}` : ''}`,
        ctx,
      );
    }

    if (this.now() - decision.decidedAt.getTime() > this.maxDecisionAgeMs) {
      throw this.refuse('decision_stale', 'decision is too old to act on — re-evaluate', ctx);
    }

    if (this.usedDecisions.has(decision.id)) {
      throw this.refuse('decision_replayed', 'this decision already released a signature', ctx);
    }

    this.checkRequirementMatchesIntent(requirement, intent, ctx);

    if (session.maxPerPayment !== undefined && gt(intent.amount, session.maxPerPayment)) {
      throw this.refuse(
        'per_payment_cap_exceeded',
        `${intent.amount} ${intent.asset} exceeds the session's ${session.maxPerPayment} per-payment cap`,
        ctx,
      );
    }
    if (session.capAmount !== undefined) {
      const after = sumDecimal([this.store.spent(session.id), intent.amount]);
      if (gt(after, session.capAmount)) {
        throw this.refuse(
          'session_cap_exceeded',
          `session has signed for ${this.store.spent(session.id)} of its ${session.capAmount} cap — ${intent.amount} more does not fit`,
          ctx,
        );
      }
    }

    // Burn the decision BEFORE the async signing step so two concurrent
    // requests carrying the same voucher cannot both pass the replay check.
    this.usedDecisions.add(decision.id);
    try {
      const result = await this.signAuthorization(account, requirement, intent);
      this.store.recordSpend(session.id, intent.amount);
      this.emit({
        type: 'signature.released',
        at: new Date(),
        sessionId: session.id,
        agentId: session.agentId,
        intentId: intent.id,
        decisionId: decision.id,
        amount: intent.amount,
      });
      return result;
    } catch (err) {
      this.usedDecisions.delete(decision.id);
      throw err;
    }
  }

  /**
   * The requirement is attacker-suppliable; the intent is voucher-bound. Every
   * field the signature commits to must therefore be derivable from — or equal
   * to — what the engine judged.
   */
  private checkRequirementMatchesIntent(
    requirement: PaymentRequirement,
    intent: PaymentIntent,
    ctx: RefusalContext,
  ): void {
    if (requirement.scheme.toLowerCase() !== 'exact') {
      throw this.refuse(
        'requirement_mismatch',
        `this signer only signs the "exact" scheme, got "${requirement.scheme}"`,
        ctx,
      );
    }
    if (chainIdForNetwork(requirement.network) === undefined) {
      throw this.refuse(
        'unsupported_network',
        `cannot sign for x402 network "${requirement.network}"`,
        ctx,
      );
    }
    if (networkToChain(requirement.network) !== intent.chain) {
      throw this.refuse(
        'requirement_mismatch',
        `requirement settles on "${requirement.network}" but the decision authorized ${intent.chain}`,
        ctx,
      );
    }
    if (resolveAsset(requirement, this.assetAddresses) !== intent.asset) {
      throw this.refuse(
        'requirement_mismatch',
        `requirement's asset "${requirement.asset}" is not the ${intent.asset} the decision authorized`,
        ctx,
      );
    }
    if (requirement.payTo.toLowerCase() !== intent.vendor.address.toLowerCase()) {
      throw this.refuse(
        'requirement_mismatch',
        `requirement pays ${requirement.payTo} but the decision authorized ${intent.vendor.address}`,
        ctx,
      );
    }
    const offered = atomicToDecimal(requirement.maxAmountRequired, requirementDecimals(requirement));
    if (compareDecimal(offered, intent.amount) !== 0) {
      throw this.refuse(
        'requirement_mismatch',
        `requirement asks ${offered} ${intent.asset} but the decision authorized ${intent.amount}`,
        ctx,
      );
    }
  }

  /** Sign exactly like the local EIP-3009 payer — same domain, types, nonce. */
  private async signAuthorization(
    account: LocalAccount,
    requirement: PaymentRequirement,
    intent: PaymentIntent,
  ): Promise<SignResult> {
    const chainId = chainIdForNetwork(requirement.network)!;
    const ts = Math.floor(this.now() / 1000);
    const authorization: ExactEvmAuthorization = {
      from: account.address,
      to: requirement.payTo as Hex,
      value: requirement.maxAmountRequired,
      validAfter: String(ts - this.skewSeconds),
      validBefore: String(ts + (requirement.maxTimeoutSeconds ?? this.defaultTimeoutSeconds)),
      nonce: intentNonce(intent.id),
    };
    const signature = await account.signTypedData({
      domain: {
        name: extraString(requirement, 'name') ?? 'USDC',
        version: extraString(requirement, 'version') ?? '2',
        chainId,
        verifyingContract: requirement.asset as Hex,
      },
      types: transferWithAuthorizationTypes,
      primaryType: 'TransferWithAuthorization',
      message: {
        from: authorization.from as Hex,
        to: authorization.to as Hex,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
        nonce: authorization.nonce as Hex,
      },
    });
    const paymentHeader = encodePaymentHeader({
      x402Version: 1,
      scheme: requirement.scheme,
      network: requirement.network,
      payload: { signature, authorization },
    });
    return { paymentHeader, from: account.address, authorization };
  }

  private refuse(code: RefusalCode, reason: string, ctx: RefusalContext): SignerError {
    this.emit({ type: 'signature.refused', at: new Date(), code, reason, ...ctx });
    return new SignerError(code, reason);
  }
}

interface RefusalContext {
  sessionId?: string;
  agentId?: string;
  intentId?: string;
}

/** EIP-712 domain name/version travel in requirement.extra (per the v1 spec). */
function extraString(requirement: PaymentRequirement, key: string): string | undefined {
  const value = requirement.extra?.[key];
  return typeof value === 'string' ? value : undefined;
}
