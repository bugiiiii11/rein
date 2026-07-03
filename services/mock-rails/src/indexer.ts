import { EventEmitter } from 'node:events';
import {
  ReinEvent,
  compareDecimal,
  type Agent,
  type PaymentIntent,
  type SettledPayment,
} from '@reinconsole/core';
import type { LedgerEntry, MockLedger } from './ledger.js';

/** The slice of the policy engine the indexer subscribes to (NATS in prod). */
export interface EngineEvents {
  onEvent(handler: (event: ReinEvent) => void): void;
}

export interface MockIndexerOptions {
  ledger: MockLedger;
  /**
   * Directory of managed agents and their wallets (the agents service in
   * prod). Called per ledger entry, so agents registered later are still seen.
   */
  agents: () => readonly Agent[];
  /** Recorded as SettledPayment.facilitator on reconciled payments. */
  facilitator?: string;
}

/** A `shadow.spend` event, extracted for convenience accessors. */
export type ShadowSpend = Extract<ReinEvent, { type: 'shadow.spend' }>;

/**
 * The mock indexer: watches the ledger and classifies every transfer that
 * leaves a managed agent wallet.
 *
 * - Matches an allowed, unsettled intent -> `payment.settled` (reconciled).
 * - No ALLOW decision behind it -> `shadow.spend` — the bypass signal that
 *   catches SDK-mode evasion and drives the upgrade to the signer tier.
 *
 * Reconciliation is memo-first (the facilitator stamps the intent id onto the
 * transfer), with a fallback match on chain+asset+amount+recipient for
 * transfers that arrive without a memo. A memo that does NOT resolve to an
 * allowed unsettled intent (denied, unknown, or already settled — a replay)
 * is never fuzzy-matched: it stays a shadow spend.
 */
export class MockIndexer {
  private readonly options: MockIndexerOptions;
  private readonly bus = new EventEmitter();
  private readonly emitted: ReinEvent[] = [];
  /** Every intent the engine has seen, by id (from `intent.created`). */
  private readonly intents = new Map<string, PaymentIntent>();
  /** Intents with an ALLOW decision, by id. */
  private readonly allowed = new Map<string, PaymentIntent>();
  private readonly settledIntents = new Set<string>();

  constructor(options: MockIndexerOptions) {
    this.options = options;
    options.ledger.onEntry((entry) => this.observe(entry));
  }

  /** Subscribe to a policy engine's event stream to learn which intents were allowed. */
  connectEngine(engine: EngineEvents): void {
    engine.onEvent((event) => {
      if (event.type === 'intent.created') {
        this.intents.set(event.intent.id, event.intent);
      } else if (event.type === 'decision.made' && event.decision.outcome === 'allow') {
        const intent = this.intents.get(event.decision.intentId);
        if (intent) this.allowed.set(intent.id, intent);
      }
    });
  }

  onEvent(handler: (event: ReinEvent) => void): void {
    this.bus.on('event', handler);
  }

  /** Everything the indexer has emitted, oldest first. */
  events(): readonly ReinEvent[] {
    return this.emitted;
  }

  settledPayments(): SettledPayment[] {
    return this.emitted.flatMap((e) => (e.type === 'payment.settled' ? [e.payment] : []));
  }

  shadowSpends(): ShadowSpend[] {
    return this.emitted.filter((e): e is ShadowSpend => e.type === 'shadow.spend');
  }

  private emit(event: ReinEvent): void {
    const parsed = ReinEvent.parse(event);
    this.emitted.push(parsed);
    this.bus.emit('event', parsed);
  }

  private agentFor(entry: LedgerEntry): string | undefined {
    for (const agent of this.options.agents()) {
      const owns = agent.wallets.some(
        (w) => w.chain === entry.chain && sameAddress(w.address, entry.from),
      );
      if (owns) return agent.id;
    }
    return undefined;
  }

  private observe(entry: LedgerEntry): void {
    const agentId = this.agentFor(entry);
    // Spend from a wallet Rein does not manage is someone else's problem.
    if (!agentId) return;

    const intent = this.reconcile(entry, agentId);
    if (intent) {
      this.settledIntents.add(intent.id);
      this.emit({
        type: 'payment.settled',
        at: entry.at,
        payment: {
          intentId: intent.id,
          txHash: entry.txHash,
          chain: entry.chain,
          blockNumber: entry.blockNumber,
          facilitator: this.options.facilitator,
          confirmedAt: entry.at,
        },
      });
      return;
    }

    this.emit({
      type: 'shadow.spend',
      at: entry.at,
      agentId,
      txHash: entry.txHash,
      chain: entry.chain,
      amount: entry.amount,
    });
  }

  private reconcile(entry: LedgerEntry, agentId: string): PaymentIntent | undefined {
    if (entry.memo !== undefined) {
      const intent = this.allowed.get(entry.memo);
      return intent && intent.agentId === agentId && !this.settledIntents.has(intent.id)
        ? intent
        : undefined;
    }
    for (const intent of this.allowed.values()) {
      if (this.settledIntents.has(intent.id)) continue;
      if (intent.agentId !== agentId) continue;
      if (intent.chain !== entry.chain || intent.asset !== entry.asset) continue;
      if (intent.vendor.address !== entry.to) continue;
      if (compareDecimal(intent.amount, entry.amount) !== 0) continue;
      return intent;
    }
    return undefined;
  }
}

/** EVM addresses compare case-insensitively; everything else compares exact. */
function sameAddress(a: string, b: string): boolean {
  if (a === b) return true;
  return a.startsWith('0x') && b.startsWith('0x') && a.toLowerCase() === b.toLowerCase();
}
