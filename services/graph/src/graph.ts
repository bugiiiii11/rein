import {
  ReputationScore,
  type Receipt,
  type ReinEvent,
  type ReputationComponents,
  type ReputationSubject,
} from '@rein/core';
import {
  EvidenceLedger,
  normalizeSubject,
  subjectKey,
  type EvidenceLedgerPort,
  type MaybePromise,
  type SubjectEvidence,
} from './evidence.js';
import {
  DEFAULT_CORRELATION_LIMIT,
  InMemoryIntentStore,
  type IntentCorrelationPort,
} from './intents.js';
import {
  blend,
  blendBase,
  confidence,
  DEFAULT_WEIGHTS,
  disputeComponent,
  longevityComponent,
  reliabilityComponent,
  volumeComponent,
  type ScoreWeights,
} from './scoring.js';

/** Anything with a Rein event bus: engine, indexer, gate, signer. */
export interface EventSource {
  onEvent(handler: (event: ReinEvent) => void): void;
}

/**
 * Where vendor scores land. `PolicyEngine.spend` satisfies this structurally,
 * so `graph.syncVendors(engine.spend)` closes the loop — durable when the
 * engine runs on @rein/store.
 */
export interface VendorReputationSink {
  setVendorReputation(host: string, score: number): void | Promise<void>;
}

export interface ReputationGraphOptions {
  weights?: Partial<ScoreWeights>;
  /** Injectable clock (scores are functions of evidence AND time). */
  now?: () => Date;
  /**
   * Max undecided intents remembered for settlement correlation. Ignored when
   * a custom `intents` store is injected (that store owns its own bound).
   */
  correlationLimit?: number;
  /**
   * Durable evidence ledger. Defaults to in-memory; @rein/store provides a
   * PGlite-backed one so scores survive a restart.
   */
  ledger?: EvidenceLedgerPort;
  /** Durable intent correlation store. Defaults to in-memory (bounded by `correlationLimit`). */
  intents?: IntentCorrelationPort;
}

export interface ManualReport {
  subject: ReputationSubject;
  kind: 'dispute' | 'endorsement';
  /** When the incident happened (defaults to now). */
  at?: Date;
  note?: string;
}

export interface SyncedVendorScore {
  host: string;
  score: number;
  confidence: number;
}

export interface SyncOptions {
  /**
   * Scores below this confidence are NOT pushed — the evaluator treats an
   * unknown reputation as indeterminate (never triggers vendorReputationLt),
   * and a thin history must stay unknown rather than condemn a newcomer.
   */
  minConfidence?: number;
}

/** A score plus the raw evidence it was derived from, render-ready. */
export interface ReputationExplanation {
  score: ReputationScore;
  weights: ScoreWeights;
  evidence: {
    attempts: number;
    settled: number;
    volume: string;
    refusals: Record<string, number>;
    shadowSpends: number;
    disputes: number;
    endorsements: number;
    firstSeen: Date;
    lastSeen: Date;
    counterparties: { subject: ReputationSubject; settled: number; volume: string }[];
  };
}

/**
 * The Rein reputation graph (Phase 3). Subscribes to the event buses both
 * sides already publish — the engine/indexer name vendors by host and agents
 * by id; a gate names payers by wallet — and accumulates per-subject evidence:
 * settlements, refusals, shadow spends, manual disputes, and settled-money
 * edges between counterparties. Scores are computed on demand (never stored)
 * from that evidence, so every number is explainable, and they feed back into
 * enforcement on both sides of the wire:
 *
 *   graph.syncVendors(engine.spend)  -> policies with vendorReputationLt fire
 *   screen: { check: payerCheck(graph) } -> a gate turns away low-rep wallets
 *
 * Event mapping notes: engine-side evidence keys agents by ULID and vendors by
 * host; gate-side evidence keys payers by wallet and recipients by payTo
 * address — distinct subjects, so feeding one graph from BOTH buses (the
 * console world) never double-counts. `payment.settled` carries only an
 * intentId, so the graph keeps a bounded intent.created correlation map.
 * Denied decisions are deliberately NOT held against anyone: a deny means
 * policy worked, not that the agent or vendor misbehaved.
 */
export class ReputationGraph {
  private readonly ledger: EvidenceLedgerPort;
  private readonly intents: IntentCorrelationPort;
  private readonly weights: ScoreWeights;
  private readonly now: () => Date;
  /** aliasKey -> canonical subject. Links are derived state (an agent registry
   * or ERC-8004 lookup knows them) — re-assert at boot; merges are idempotent. */
  private readonly aliases = new Map<string, ReputationSubject>();

  constructor(options: ReputationGraphOptions = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...options.weights };
    this.now = options.now ?? (() => new Date());
    this.ledger = options.ledger ?? new EvidenceLedger();
    this.intents =
      options.intents ??
      new InMemoryIntentStore(options.correlationLimit ?? DEFAULT_CORRELATION_LIMIT);
  }

  /** Subscribe to a bus. Returns `this` so construction chains. */
  observe(source: EventSource): this {
    source.onEvent((event) => this.ingest(event));
    return this;
  }

  /**
   * Fire-and-forget a port write: bus handlers cannot await, and a rejecting
   * durable write must never become an unhandled rejection (Node kills the
   * process). Failures are the port's to surface — flush() throws them.
   */
  private fire(write: MaybePromise<void>): void {
    void Promise.resolve(write).catch(() => undefined);
  }

  /**
   * Declare that `alias` is the same real-world party as `canonical` (the
   * ERC-8004 identity story: one identity, many addresses/ids — an engine
   * agent's ULID and its paying wallet, or a vendor's host and its payTo
   * address). Everything already known about the alias is folded into the
   * canonical subject, and all future evidence and lookups for the alias
   * resolve to it. Idempotent — re-asserting known links at boot is free.
   */
  link(canonical: ReputationSubject, alias: ReputationSubject): void {
    const target = normalizeSubject(this.resolve(canonical)); // flatten chains
    const aliasKey = subjectKey(alias);
    if (subjectKey(target) === aliasKey) return;
    this.aliases.set(aliasKey, target);
    // Repoint any alias that resolved THROUGH this alias (a->b then b->c).
    for (const [key, resolved] of this.aliases) {
      if (subjectKey(resolved) === aliasKey) this.aliases.set(key, target);
    }
    this.fire(this.ledger.merge(target, alias));
  }

  /** The canonical subject for a possibly-aliased one. */
  private resolve(subject: ReputationSubject): ReputationSubject {
    return this.aliases.get(subjectKey(subject)) ?? subject;
  }

  ingest(event: ReinEvent): void {
    const atMs = event.at.getTime();
    switch (event.type) {
      case 'intent.created': {
        this.fire(
          this.intents.remember(event.intent.id, {
            agentId: event.intent.agentId,
            host: event.intent.vendor.host,
            amount: event.intent.amount,
          }),
        );
        return;
      }
      case 'decision.made': {
        if (event.decision.outcome !== 'allow') return;
        const facts = this.intents.peek(event.decision.intentId);
        if (!facts) return;
        this.fire(this.ledger.recordAttempt(this.resolve({ kind: 'agent', id: facts.agentId }), atMs));
        this.fire(this.ledger.recordAttempt(this.resolve({ kind: 'vendor', id: facts.host }), atMs));
        return;
      }
      case 'payment.settled': {
        const facts = this.intents.take(event.payment.intentId);
        if (!facts) return; // unattributable — no subject to credit
        const agent = this.resolve({ kind: 'agent', id: facts.agentId });
        const vendor = this.resolve({ kind: 'vendor', id: facts.host });
        this.fire(this.ledger.recordSettlement(agent, vendor, facts.amount, atMs));
        return;
      }
      case 'shadow.spend': {
        this.fire(this.ledger.recordShadowSpend(this.resolve({ kind: 'agent', id: event.agentId }), atMs));
        return;
      }
      case 'signature.refused': {
        if (!event.agentId) return;
        this.fire(
          this.ledger.recordRefusal(this.resolve({ kind: 'agent', id: event.agentId }), event.code, atMs),
        );
        return;
      }
      case 'gate.settled': {
        const payer = this.resolve({ kind: 'agent', id: event.receipt.payer });
        const recipient = this.resolve({ kind: 'vendor', id: event.receipt.payTo });
        this.fire(this.ledger.recordAttempt(payer, atMs));
        this.fire(this.ledger.recordAttempt(recipient, atMs));
        this.fire(this.ledger.recordSettlement(payer, recipient, event.receipt.amount, atMs));
        return;
      }
      case 'gate.refused': {
        if (!event.payer) return;
        const payer = this.resolve({ kind: 'agent', id: event.payer });
        this.fire(this.ledger.recordAttempt(payer, atMs));
        this.fire(this.ledger.recordRefusal(payer, event.code, atMs));
        return;
      }
      // signature.released and gate.quoted carry no evidence the engine-side
      // events don't already: released duplicates the allow that preceded it,
      // and a quote names no payer.
      case 'signature.released':
      case 'gate.quoted':
        return;
    }
  }

  /**
   * Agent-side alternative to observing the engine bus: feed the SDK guard's
   * onReceipt straight in. Connect events OR receipts per side, not both —
   * a receipt restates the decision/settlement the bus already carried.
   */
  ingestReceipt(receipt: Receipt): void {
    if (receipt.outcome !== 'allow') return; // policy verdicts are not subject badness
    const atMs = receipt.createdAt.getTime();
    const agent = this.resolve({ kind: 'agent', id: receipt.agentId });
    const vendor = this.resolve({ kind: 'vendor', id: receipt.vendorHost });
    this.fire(this.ledger.recordAttempt(agent, atMs));
    this.fire(this.ledger.recordAttempt(vendor, atMs));
    if (receipt.settlement?.txHash) {
      this.fire(this.ledger.recordSettlement(agent, vendor, receipt.amount, atMs));
    }
  }

  /** Record an out-of-band dispute or endorsement against a subject. */
  report(input: ManualReport): void {
    const atMs = (input.at ?? this.now()).getTime();
    const subject = this.resolve(input.subject);
    if (input.kind === 'dispute') this.fire(this.ledger.recordDispute(subject, atMs));
    else this.fire(this.ledger.recordEndorsement(subject, atMs));
  }

  /** Await any pending durable writes (no-op for in-memory stores). */
  async flush(): Promise<void> {
    await this.ledger.flush?.();
    await this.intents.flush?.();
  }

  /** The score for one subject, or undefined when nothing is known (fairness).
   *  Aliased subjects resolve to their canonical identity — a linked wallet
   *  answers with the merged history, on both sides of the wire. */
  score(subject: ReputationSubject): ReputationScore | undefined {
    const ev = this.ledger.get(this.resolve(subject));
    return ev && this.scoreOf(ev);
  }

  /** All known scores, best first. */
  scores(kind?: ReputationSubject['kind']): ReputationScore[] {
    const out: ReputationScore[] = [];
    for (const ev of this.ledger.all()) {
      if (kind && ev.subject.kind !== kind) continue;
      out.push(this.scoreOf(ev));
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** The score plus the raw evidence behind it. */
  explain(subject: ReputationSubject): ReputationExplanation | undefined {
    const ev = this.ledger.get(this.resolve(subject));
    if (!ev) return undefined;
    return {
      score: this.scoreOf(ev),
      weights: this.weights,
      evidence: {
        attempts: ev.attempts,
        settled: ev.settled,
        volume: ev.volume,
        refusals: { ...ev.refusals },
        shadowSpends: ev.shadowSpends,
        disputes: ev.disputes,
        endorsements: ev.endorsements,
        firstSeen: new Date(ev.firstSeenMs),
        lastSeen: new Date(ev.lastSeenMs),
        counterparties: [...ev.counterparties.entries()].map(([key, line]) => {
          const [kind, ...id] = key.split(':');
          return {
            subject: { kind: kind as ReputationSubject['kind'], id: id.join(':') },
            settled: line.settled,
            volume: line.volume,
          };
        }),
      },
    };
  }

  /**
   * Push every vendor score that clears the confidence floor into the engine's
   * spend store (or any sink). Returns what was pushed. Low-confidence scores
   * are withheld so `vendorReputationLt` keeps treating thin histories as
   * unknown — the evaluator's no-data-no-trigger rule stays intact end to end.
   */
  async syncVendors(
    sink: VendorReputationSink,
    options: SyncOptions = {},
  ): Promise<SyncedVendorScore[]> {
    const minConfidence = options.minConfidence ?? 0.3;
    const pushed: SyncedVendorScore[] = [];
    for (const ev of this.ledger.all()) {
      if (ev.subject.kind !== 'vendor') continue;
      const score = this.scoreOf(ev);
      if (score.confidence < minConfidence) continue;
      await sink.setVendorReputation(ev.subject.id, score.score);
      pushed.push({ host: ev.subject.id, score: score.score, confidence: score.confidence });
    }
    return pushed;
  }

  /** Number of subjects with evidence. */
  subjects(): number {
    return this.ledger.size;
  }

  private scoreOf(ev: SubjectEvidence): ReputationScore {
    const nowMs = this.now().getTime();
    const components: ReputationComponents = {
      volume: volumeComponent(ev),
      longevity: longevityComponent(ev, nowMs),
      disputeRate: disputeComponent(ev),
      counterpartyQuality: this.counterpartyQuality(ev, nowMs),
      settlementReliability: reliabilityComponent(ev),
    };
    return ReputationScore.parse({
      subject: ev.subject,
      score: blend(components, this.weights),
      components,
      confidence: confidence(ev, nowMs),
      asOf: new Date(nowMs),
    });
  }

  /** One-hop mean of the counterparties' base scores; neutral 50 when alone. */
  private counterpartyQuality(ev: SubjectEvidence, nowMs: number): number {
    if (ev.counterparties.size === 0) return 50;
    let total = 0;
    for (const key of ev.counterparties.keys()) {
      const other = this.ledger.getByKey(key);
      total += other ? blendBase(other, nowMs, this.weights) : 50;
    }
    return total / ev.counterparties.size;
  }
}

export interface PayerCheckOptions {
  /** Refuse payers scoring below this (default 40). */
  denyBelow?: number;
  /** Ignore scores below this confidence (default 0.3) — newcomers pass. */
  minConfidence?: number;
}

/**
 * Reputation-driven gate screening: plugs into @rein/gate's `screen.check`.
 * Unknown wallets and thin histories pass (same fairness rule as the engine
 * sync); a confident low score is turned away at the door, before any
 * facilitator round-trip.
 */
export function payerCheck(
  graph: ReputationGraph,
  options: PayerCheckOptions = {},
): (payer: string) => string | undefined {
  const denyBelow = options.denyBelow ?? 40;
  const minConfidence = options.minConfidence ?? 0.3;
  return (payer) => {
    const score = graph.score({ kind: 'agent', id: payer });
    if (!score || score.confidence < minConfidence) return undefined;
    if (score.score >= denyBelow) return undefined;
    return `payer reputation ${score.score} is below this gate's floor of ${denyBelow}`;
  };
}
