import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { GateReceipt, gt, newId, sumDecimal, type ReinEvent } from '@reinconsole/core';
import { atomicToDecimal, type PaymentRequired, type PaymentRequirement } from '@reinconsole/sdk';
import { GateError, type GateRefusalCode } from './errors.js';
import { RailsUnreachableError, type GateRails, type GateSettlement } from './rails.js';
import {
  matchRoute,
  requirementFor,
  routeDecimals,
  type GateRoute,
  type PaymentDefaults,
} from './routes.js';
import { InMemoryGateStore, type GateStorePort, type MaybePromise } from './stores.js';
import {
  AttemptWindow,
  payerReceiptsSince,
  validateVelocity,
  type GateVelocity,
} from './velocity.js';
import { buildPaymentRequiredV2, encodeBase64Json, sameNetwork } from './v2.js';
import { inspectPaymentHeader, type InspectedPayment } from './wire.js';

/** Wallet-address screening. Addresses compare case-insensitively (EVM rule). */
export interface GateScreen {
  /** If set, ONLY these payers may pay. */
  allowPayers?: readonly string[];
  /** These payers are always refused, allowlist or not. */
  denyPayers?: readonly string[];
  /**
   * Dynamic screening hook, consulted after the static lists with the payer
   * address as presented. Return a refusal reason to turn the payer away
   * (403, code `payer_denied`); return undefined to let the payment proceed.
   * Reputation-driven screening (@reinconsole/graph's `payerCheck`) plugs in here.
   */
  check?: (payer: string) => string | undefined;
}

export interface GateOptions {
  /** Priced routes; first match wins. Unmatched requests pass through free. */
  routes: readonly GateRoute[];
  /** Settlement rails: mockFacilitatorRails(...) or facilitatorClientRails(...). */
  rails: GateRails;
  /** Default recipient address (a route can override). */
  payTo: string;
  /** Default x402 network id, e.g. "base" (mock rails) or "base-sepolia". */
  network: string;
  /** Default asset: a symbol (mock rails) or token contract address (real). */
  asset: string;
  decimals?: number;
  maxTimeoutSeconds?: number;
  /** EIP-712 domain hints etc., quoted on every requirement. */
  extra?: Record<string, unknown>;
  screen?: GateScreen;
  /**
   * Also advertise quotes on the x402 v2 wire: 402 outcomes gain a
   * `paymentRequiredHeader` (base64 PaymentRequired, CAIP-2 networks) that the
   * adapters send as `PAYMENT-REQUIRED`, alongside the unchanged v1 body —
   * dual-stack, each dialect reads its own channel. Off by default. Note the
   * gate ACCEPTS v2 payments (PAYMENT-SIGNATURE envelopes) regardless of this
   * flag; it only controls what quotes advertise.
   */
  advertiseV2?: boolean;
  /** Per-payer velocity limits (see GateVelocity). Off when omitted. */
  velocity?: GateVelocity;
  /**
   * Rails transport-failure retry policy. `attempts` counts EXTRA tries after
   * the first (default 2), spaced `backoffMs * attemptNumber` apart (default
   * 250ms; pass 0 in tests). Applies only to transport failures — a GateError
   * from the rails is a semantic verdict and is never retried. See GateRails
   * for which settle failures are retry-safe.
   */
  retry?: { attempts?: number; backoffMs?: number };
  /** Injectable clock (tests). */
  now?: () => Date;
  /**
   * Gate storage. Defaults in-memory; pass @reinconsole/store's gate store and
   * receipts, revenue stats, and burned replay slots survive restarts.
   */
  store?: GateStorePort;
}

/** The transport-agnostic request shape every adapter reduces to. */
export interface GateRequest {
  method: string;
  /** Absolute request URL (quoted verbatim as the requirement's resource). */
  url: string;
  /** Raw X-PAYMENT header value, or null when absent. */
  payment: string | null;
}

export type GateOutcome =
  /** No priced route matched — the vendor serves this request for free. */
  | { kind: 'open' }
  /** No payment attached: here is what this resource costs. The optional
   *  `paymentRequiredHeader` (advertiseV2) is the base64 v2 PaymentRequired
   *  for the PAYMENT-REQUIRED response header. */
  | { kind: 'quote'; status: 402; body: PaymentRequired; paymentRequiredHeader?: string }
  /**
   * A payment was attached and turned away. 403 = screening, 402 = re-quote,
   * 429 = throttled (retryAfterSeconds set when a slot will free), 503 = the
   * rails failed us (`rails_unavailable` = provably unsettled, slot released;
   * `settle_unknown` = fate unknown, slot stays burned — do not re-pay blindly).
   */
  | {
      kind: 'refused';
      status: 402 | 403 | 429 | 503;
      code: GateRefusalCode;
      reason: string;
      body: unknown;
      retryAfterSeconds?: number;
      /** On 402 re-quotes with advertiseV2: the v2 PAYMENT-REQUIRED value. */
      paymentRequiredHeader?: string;
    }
  /** Verified and settled — serve, attaching settlementHeader as X-PAYMENT-RESPONSE. */
  | { kind: 'paid'; receipt: GateReceipt; settlementHeader: string };

export interface GateLineStats {
  settled: number;
  revenue: string;
}

export interface GateStats {
  quoted: number;
  settled: number;
  refused: number;
  /** Decimal revenue grouped by asset. */
  revenue: Record<string, string>;
  /** Per route pattern. */
  routes: Record<string, GateLineStats>;
  /** Per payer (lowercased address). */
  payers: Record<string, GateLineStats>;
}

/**
 * Rein Gate — the vendor side of the wire. One gate fronts one vendor API:
 * it quotes x402 requirements for priced routes, cross-checks and screens
 * incoming payments, settles them through the configured rails, and keeps
 * vendor-side receipts so monetization is observable, not anecdotal.
 *
 * Check order for a presented payment: envelope decode -> rate limit ->
 * quote consistency (scheme/network/amount/recipient) -> payer screening ->
 * velocity caps -> replay burn -> rails verify -> rails settle. The replay
 * slot is burned BEFORE the async legs so two concurrent copies of the same
 * payment cannot both settle (the mock ledger, unlike the chain, would
 * happily double-spend); throttle refusals fire before the burn so a
 * velocity-refused header can be re-presented once its window clears.
 */
export class Gate {
  private readonly routes: readonly GateRoute[];
  private readonly rails: GateRails;
  private readonly defaults: PaymentDefaults;
  private readonly allowPayers: Set<string> | undefined;
  private readonly denyPayers: Set<string>;
  private readonly screenCheck: ((payer: string) => string | undefined) | undefined;
  private readonly advertiseV2: boolean;
  private readonly velocity: GateVelocity | undefined;
  private readonly attempts: AttemptWindow | undefined;
  private readonly retryPolicy: { attempts: number; backoffMs: number };
  private readonly now: () => Date;
  private readonly bus = new EventEmitter();
  private readonly store: GateStorePort;

  constructor(options: GateOptions) {
    this.routes = options.routes;
    this.rails = options.rails;
    this.defaults = {
      payTo: options.payTo,
      network: options.network,
      asset: options.asset,
      decimals: options.decimals,
      maxTimeoutSeconds: options.maxTimeoutSeconds,
      extra: options.extra,
    };
    this.allowPayers = options.screen?.allowPayers
      ? new Set(options.screen.allowPayers.map((a) => a.toLowerCase()))
      : undefined;
    this.denyPayers = new Set((options.screen?.denyPayers ?? []).map((a) => a.toLowerCase()));
    this.screenCheck = options.screen?.check;
    this.advertiseV2 = options.advertiseV2 ?? false;
    if (options.velocity) validateVelocity(options.velocity);
    this.velocity = options.velocity;
    this.attempts = options.velocity?.maxAttempts
      ? new AttemptWindow(options.velocity.windowMs)
      : undefined;
    this.retryPolicy = {
      attempts: options.retry?.attempts ?? 2,
      backoffMs: options.retry?.backoffMs ?? 250,
    };
    this.now = options.now ?? (() => new Date());
    this.store = options.store ?? new InMemoryGateStore();
  }

  onEvent(handler: (event: ReinEvent) => void): void {
    this.bus.on('event', handler);
  }

  get receipts(): readonly GateReceipt[] {
    return this.store.receipts();
  }

  /** Drain trailing telemetry writes; throws the first failure (durable stores). */
  async flush(): Promise<void> {
    await this.store.flush?.();
  }

  /** Telemetry writes may trail (cache-then-persist) — a store failure,
   *  rejected OR thrown synchronously, must surface through flush() and can
   *  never alter a payment outcome (a receipt write turning a SETTLED payment
   *  into a 500 would charge the payer and serve nothing). */
  private fire(write: () => MaybePromise<void>): void {
    try {
      void Promise.resolve(write()).catch(() => undefined);
    } catch {
      // swallowed by design — see above
    }
  }

  /** The requirement a given request would be quoted (or undefined if free). */
  quoteFor(method: string, url: string): PaymentRequirement | undefined {
    const route = matchRoute(this.routes, method, new URL(url).pathname);
    return route && requirementFor(route, this.defaults, url);
  }

  async handle(request: GateRequest): Promise<GateOutcome> {
    const url = new URL(request.url);
    const method = (request.method || 'GET').toUpperCase();
    const route = matchRoute(this.routes, method, url.pathname);
    if (!route) return { kind: 'open' };

    const requirement = requirementFor(route, this.defaults, request.url);
    const amount = atomicToDecimal(
      requirement.maxAmountRequired,
      routeDecimals(route, this.defaults),
    );

    if (request.payment === null) {
      this.fire(() => this.store.recordQuote());
      this.emit({
        type: 'gate.quoted',
        at: this.now(),
        resource: url.pathname,
        method,
        amount,
        asset: requirement.asset,
        network: requirement.network,
      });
      return {
        kind: 'quote',
        status: 402,
        body: { x402Version: 1, accepts: [requirement], error: 'X-PAYMENT header is required' },
        ...this.v2Quote(requirement, 'PAYMENT-SIGNATURE header is required'),
      };
    }

    let payer: string | undefined;
    try {
      const payment = inspectPaymentHeader(request.payment);
      payer = payment.payer;
      this.checkRate(payment.payer);
      this.checkConsistency(payment, requirement);
      this.screenPayer(payment.payer);
      this.checkVelocity(payment.payer, requirement, amount);
      await this.burnReplay(request.payment);
      const settlement = await this.settleThroughRails(request.payment, requirement);

      const receipt = GateReceipt.parse({
        id: newId('grc'),
        at: this.now(),
        route: route.path,
        resource: url.pathname,
        method,
        payer: payment.payer,
        payTo: requirement.payTo,
        amount,
        amountAtomic: requirement.maxAmountRequired,
        asset: requirement.asset,
        network: requirement.network,
        transaction: settlement.transaction,
      });
      this.fire(() => this.store.appendReceipt(receipt));
      this.emit({ type: 'gate.settled', at: receipt.at, receipt });
      return { kind: 'paid', receipt, settlementHeader: settlement.header };
    } catch (err) {
      if (!(err instanceof GateError)) throw err;
      return this.refuse(err, url.pathname, requirement, payer);
    }
  }

  stats(): GateStats {
    const receipts = this.store.receipts();
    const revenue: Record<string, string[]> = {};
    const routes: Record<string, { settled: number; amounts: string[] }> = {};
    const payers: Record<string, { settled: number; amounts: string[] }> = {};
    for (const receipt of receipts) {
      (revenue[receipt.asset] ??= []).push(receipt.amount);
      const routeLine = (routes[receipt.route] ??= { settled: 0, amounts: [] });
      routeLine.settled += 1;
      routeLine.amounts.push(receipt.amount);
      const payerLine = (payers[receipt.payer.toLowerCase()] ??= { settled: 0, amounts: [] });
      payerLine.settled += 1;
      payerLine.amounts.push(receipt.amount);
    }
    const sumLines = (lines: Record<string, { settled: number; amounts: string[] }>) =>
      Object.fromEntries(
        Object.entries(lines).map(([key, line]) => [
          key,
          { settled: line.settled, revenue: sumDecimal(line.amounts) },
        ]),
      );
    return {
      quoted: this.store.quoted(),
      settled: receipts.length,
      refused: this.store.refused(),
      revenue: Object.fromEntries(
        Object.entries(revenue).map(([asset, amounts]) => [asset, sumDecimal(amounts)]),
      ),
      routes: sumLines(routes),
      payers: sumLines(payers),
    };
  }

  private emit(event: ReinEvent): void {
    this.bus.emit('event', event);
  }

  private checkConsistency(payment: InspectedPayment, requirement: PaymentRequirement): void {
    if (payment.scheme.toLowerCase() !== requirement.scheme.toLowerCase()) {
      throw new GateError(
        'scheme_mismatch',
        `payment scheme "${payment.scheme}" does not match the quoted "${requirement.scheme}"`,
      );
    }
    // Compared through CAIP-2 normalization: a v2 payment naming
    // "eip155:84532" matches a gate configured with v1's "base-sepolia".
    if (!sameNetwork(payment.network, requirement.network)) {
      throw new GateError(
        'network_mismatch',
        `payment is on "${payment.network}" but the quote wants "${requirement.network}"`,
      );
    }
    if (payment.value !== requirement.maxAmountRequired) {
      throw new GateError(
        'amount_mismatch',
        `payment of ${payment.value} does not match the quoted ${requirement.maxAmountRequired}`,
      );
    }
    if (payment.to.toLowerCase() !== requirement.payTo.toLowerCase()) {
      throw new GateError(
        'recipient_mismatch',
        `payment pays "${payment.to}" but the quote pays "${requirement.payTo}"`,
      );
    }
  }

  /**
   * Presentation rate limit — first check after decode, so a hammering payer
   * is shed before any further work. Every presentation counts, including
   * ones that would go on to fail consistency or screening.
   */
  private checkRate(payer: string): void {
    const max = this.velocity?.maxAttempts;
    if (!max || !this.attempts) return;
    const key = payer.toLowerCase();
    const nowMs = this.now().getTime();
    if (this.attempts.record(key, nowMs) > max) {
      const retryAfterSeconds = Math.ceil(this.attempts.msUntilSlot(key, nowMs, max) / 1000);
      throw new GateError(
        'rate_limited',
        `payer ${payer} exceeded ${max} payment presentations per ${this.velocity!.windowMs}ms`,
        { retryAfterSeconds },
      );
    }
  }

  /**
   * Settled-spend velocity caps, derived from receipts at check time (restart
   * -safe on durable stores). Runs BEFORE the replay burn on purpose: a
   * velocity refusal is temporal, not a payment defect, so the same signed
   * header may come back once the window clears.
   */
  private checkVelocity(payer: string, requirement: PaymentRequirement, amount: string): void {
    const v = this.velocity;
    if (!v || (v.maxPayments === undefined && v.maxAmount === undefined)) return;
    const nowMs = this.now().getTime();
    const recent = payerReceiptsSince(this.store.receipts(), payer, nowMs - v.windowMs);

    const oldest = recent[0];
    if (v.maxPayments !== undefined && oldest !== undefined && recent.length >= v.maxPayments) {
      const retryAfterSeconds = secondsUntil(oldest.at.getTime() + v.windowMs, nowMs);
      throw new GateError(
        'velocity_exceeded',
        `payer ${payer} already settled ${recent.length} payments in the last ${v.windowMs}ms; the cap is ${v.maxPayments}`,
        { retryAfterSeconds },
      );
    }

    if (v.maxAmount !== undefined) {
      const sameAsset = recent.filter((r) => r.asset === requirement.asset);
      const oldestSameAsset = sameAsset[0];
      const wouldBe = sumDecimal([...sameAsset.map((r) => r.amount), amount]);
      if (gt(wouldBe, v.maxAmount)) {
        // No Retry-After when the window is already empty — a single payment
        // above the cap will never clear, and saying "try later" would lie.
        const retryAfterSeconds =
          oldestSameAsset !== undefined
            ? secondsUntil(oldestSameAsset.at.getTime() + v.windowMs, nowMs)
            : undefined;
        throw new GateError(
          'velocity_exceeded',
          `settling ${amount} ${requirement.asset} would put payer ${payer} at ${wouldBe} in the last ${v.windowMs}ms; the cap is ${v.maxAmount}`,
          { retryAfterSeconds },
        );
      }
    }
  }

  /**
   * Drive both rails legs under the retry policy (see GateRails for the error
   * taxonomy). GateErrors are semantic verdicts and pass straight through.
   * Transport failures:
   *
   * - verify (read-only): every transport failure is retried; exhausted ->
   *   `rails_unavailable`, and the slot is released (settle never ran).
   * - settle: only RailsUnreachableError (provably never sent) is retried;
   *   exhausted -> `rails_unavailable` + release (still provably unsettled).
   *   Anything else is ambiguous — the money MAY have moved — so it refuses
   *   `settle_unknown` immediately and the slot STAYS burned: on real rails a
   *   re-present would misreport (nonce already used -> settle_failed), and on
   *   the mock ledger it would double-spend. Vendors reconcile ambiguous
   *   settles against transaction records (e.g. the on-chain indexer).
   */
  private async settleThroughRails(
    paymentHeader: string,
    requirement: PaymentRequirement,
  ): Promise<GateSettlement> {
    await this.railsLeg('verify', paymentHeader, () =>
      this.rails.verify(paymentHeader, requirement),
    );
    return this.railsLeg('settle', paymentHeader, () =>
      this.rails.settle(paymentHeader, requirement),
    );
  }

  private async railsLeg<T>(
    leg: 'verify' | 'settle',
    paymentHeader: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const { attempts, backoffMs } = this.retryPolicy;
    let lastErr: unknown;
    for (let attempt = 0; attempt <= attempts; attempt++) {
      if (attempt > 0 && backoffMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, backoffMs * attempt));
      }
      try {
        return await fn();
      } catch (err) {
        if (err instanceof GateError) throw err;
        if (leg === 'settle' && !(err instanceof RailsUnreachableError)) {
          throw new GateError(
            'settle_unknown',
            `settlement fate unknown (${messageOf(err)}); do not re-pay before reconciling`,
          );
        }
        lastErr = err;
      }
    }
    // Exhausted retries on provably-unsettled failures: the payment did not
    // happen. Release the slot so the same header can retry when rails return;
    // a failed release just leaves it burned (conservative).
    try {
      await this.store.releaseReplay?.(replayKey(paymentHeader));
    } catch {
      // slot stays burned — the payer re-signs instead
    }
    throw new GateError(
      'rails_unavailable',
      `payment rails unreachable after ${attempts + 1} attempts (${messageOf(lastErr)}); the payment was NOT settled`,
    );
  }

  private screenPayer(payer: string): void {
    const key = payer.toLowerCase();
    if (this.denyPayers.has(key)) {
      throw new GateError('payer_denied', `payer ${payer} is blocked by this gate`);
    }
    if (this.allowPayers && !this.allowPayers.has(key)) {
      throw new GateError('payer_not_allowed', `payer ${payer} is not on this gate's allowlist`);
    }
    const reason = this.screenCheck?.(payer);
    if (reason) {
      throw new GateError('payer_denied', reason);
    }
  }

  /**
   * Burn the replay slot. The store's check-and-set is sync at call time
   * (concurrent copies cannot both pass); the await is the durability barrier
   * — on a durable store the burn is on disk before verify/settle run, so a
   * crash mid-settle cannot resurrect the slot on restart. A store WRITE
   * failure is not a GateError: it escapes as a 500, because "we cannot
   * guarantee replay protection" must never settle a payment.
   */
  private async burnReplay(paymentHeader: string): Promise<void> {
    if (!(await this.store.burnReplay(replayKey(paymentHeader)))) {
      throw new GateError(
        'payment_replayed',
        'this exact payment was already presented; one settlement per payment',
      );
    }
  }

  private refuse(
    err: GateError,
    resource: string,
    requirement: PaymentRequirement,
    payer: string | undefined,
  ): GateOutcome {
    this.fire(() => this.store.recordRefusal());
    this.emit({
      type: 'gate.refused',
      at: this.now(),
      code: err.code,
      reason: err.message,
      resource,
      payer,
    });
    const retry =
      err.retryAfterSeconds !== undefined ? { retryAfterSeconds: err.retryAfterSeconds } : {};
    if (err.code === 'payer_denied' || err.code === 'payer_not_allowed') {
      return {
        kind: 'refused',
        status: 403,
        code: err.code,
        reason: err.message,
        body: { error: 'refused', code: err.code, reason: err.message },
      };
    }
    if (err.code === 'rate_limited' || err.code === 'velocity_exceeded') {
      return {
        kind: 'refused',
        status: 429,
        code: err.code,
        reason: err.message,
        body: { error: 'refused', code: err.code, reason: err.message, ...retry },
        ...retry,
      };
    }
    if (err.code === 'rails_unavailable' || err.code === 'settle_unknown') {
      // No accepts re-quote: after settle_unknown a re-pay could double-charge,
      // and rails_unavailable means the SAME header will work later.
      return {
        kind: 'refused',
        status: 503,
        code: err.code,
        reason: err.message,
        body: {
          error: 'refused',
          code: err.code,
          reason: err.message,
          retriable: err.code === 'rails_unavailable',
        },
      };
    }
    // Payment problems re-quote per the x402 spec: 402 + accepts + error.
    return {
      kind: 'refused',
      status: 402,
      code: err.code,
      reason: err.message,
      body: { x402Version: 1, accepts: [requirement], error: err.message },
      ...this.v2Quote(requirement, err.message),
    };
  }

  /** The v2 half of a dual-stack 402 (see advertiseV2), or nothing. */
  private v2Quote(
    requirement: PaymentRequirement,
    error: string,
  ): { paymentRequiredHeader: string } | Record<string, never> {
    if (!this.advertiseV2) return {};
    return {
      paymentRequiredHeader: encodeBase64Json(buildPaymentRequiredV2(requirement, error)),
    };
  }
}

export function createGate(options: GateOptions): Gate {
  return new Gate(options);
}

/** The replay-slot key: hash of the exact header bytes as presented. */
function replayKey(paymentHeader: string): string {
  return createHash('sha256').update(paymentHeader).digest('hex');
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Whole seconds (>= 1) from nowMs until atMs — Retry-After semantics. */
function secondsUntil(atMs: number, nowMs: number): number {
  return Math.max(1, Math.ceil((atMs - nowMs) / 1000));
}
