import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { GateReceipt, newId, sumDecimal, type ReinEvent } from '@rein/core';
import { atomicToDecimal, type PaymentRequired, type PaymentRequirement } from '@rein/sdk';
import { GateError, type GateRefusalCode } from './errors.js';
import type { GateRails } from './rails.js';
import {
  matchRoute,
  requirementFor,
  routeDecimals,
  type GateRoute,
  type PaymentDefaults,
} from './routes.js';
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
   * Reputation-driven screening (@rein/graph's `payerCheck`) plugs in here.
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
  /** Injectable clock (tests). */
  now?: () => Date;
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
  /** No payment attached: here is what this resource costs. */
  | { kind: 'quote'; status: 402; body: PaymentRequired }
  /** A payment was attached and turned away. 403 = screening, 402 = re-quote. */
  | { kind: 'refused'; status: 402 | 403; code: GateRefusalCode; reason: string; body: unknown }
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
 * Check order for a presented payment: envelope decode -> quote consistency
 * (scheme/network/amount/recipient) -> payer screening -> replay burn ->
 * rails verify -> rails settle. The replay slot is burned BEFORE the async
 * legs so two concurrent copies of the same payment cannot both settle
 * (the mock ledger, unlike the chain, would happily double-spend).
 */
export class Gate {
  private readonly routes: readonly GateRoute[];
  private readonly rails: GateRails;
  private readonly defaults: PaymentDefaults;
  private readonly allowPayers: Set<string> | undefined;
  private readonly denyPayers: Set<string>;
  private readonly screenCheck: ((payer: string) => string | undefined) | undefined;
  private readonly now: () => Date;
  private readonly bus = new EventEmitter();
  private readonly seenPayments = new Set<string>();
  private readonly receiptLog: GateReceipt[] = [];
  private quoted = 0;
  private refusedCount = 0;

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
    this.now = options.now ?? (() => new Date());
  }

  onEvent(handler: (event: ReinEvent) => void): void {
    this.bus.on('event', handler);
  }

  get receipts(): readonly GateReceipt[] {
    return this.receiptLog;
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
      this.quoted += 1;
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
      };
    }

    let payer: string | undefined;
    try {
      const payment = inspectPaymentHeader(request.payment);
      payer = payment.payer;
      this.checkConsistency(payment, requirement);
      this.screenPayer(payment.payer);
      this.burnReplay(request.payment);
      await this.rails.verify(request.payment, requirement);
      const settlement = await this.rails.settle(request.payment, requirement);

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
      this.receiptLog.push(receipt);
      this.emit({ type: 'gate.settled', at: receipt.at, receipt });
      return { kind: 'paid', receipt, settlementHeader: settlement.header };
    } catch (err) {
      if (!(err instanceof GateError)) throw err;
      return this.refuse(err, url.pathname, requirement, payer);
    }
  }

  stats(): GateStats {
    const revenue: Record<string, string[]> = {};
    const routes: Record<string, { settled: number; amounts: string[] }> = {};
    const payers: Record<string, { settled: number; amounts: string[] }> = {};
    for (const receipt of this.receiptLog) {
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
      quoted: this.quoted,
      settled: this.receiptLog.length,
      refused: this.refusedCount,
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
    if (payment.network !== requirement.network) {
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

  private burnReplay(paymentHeader: string): void {
    const key = createHash('sha256').update(paymentHeader).digest('hex');
    if (this.seenPayments.has(key)) {
      throw new GateError(
        'payment_replayed',
        'this exact payment was already presented; one settlement per payment',
      );
    }
    this.seenPayments.add(key);
  }

  private refuse(
    err: GateError,
    resource: string,
    requirement: PaymentRequirement,
    payer: string | undefined,
  ): GateOutcome {
    this.refusedCount += 1;
    this.emit({
      type: 'gate.refused',
      at: this.now(),
      code: err.code,
      reason: err.message,
      resource,
      payer,
    });
    if (err.code === 'payer_denied' || err.code === 'payer_not_allowed') {
      return {
        kind: 'refused',
        status: 403,
        code: err.code,
        reason: err.message,
        body: { error: 'refused', code: err.code, reason: err.message },
      };
    }
    // Payment problems re-quote per the x402 spec: 402 + accepts + error.
    return {
      kind: 'refused',
      status: 402,
      code: err.code,
      reason: err.message,
      body: { x402Version: 1, accepts: [requirement], error: err.message },
    };
  }
}

export function createGate(options: GateOptions): Gate {
  return new Gate(options);
}
