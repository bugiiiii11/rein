import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
  canonicalIntent,
  newId,
  PaymentIntent,
  Vendor,
  TaskContext,
  Asset,
  Chain,
  AgentId,
  IntentId,
  DecimalString,
  Agent,
  Policy,
  type Breaker,
  type ApprovalGrant,
  type ApprovalRequest,
  SettlementReport,
  Heartbeat,
  type Decision,
  type LivenessExpectation,
  type LivenessWatchInput,
  type ReinEvent,
} from '@reinconsole/core';
import {
  breakerTrips,
  evaluate,
  policyApplies,
  type EvaluationResult,
} from './evaluator.js';
import {
  InMemorySpendStore,
  InMemoryPolicyStore,
  InMemoryAgentRegistry,
  InMemorySettlementStore,
  parseWindowMs,
  type SpendStorePort,
  type PolicyStorePort,
  type AgentRegistryPort,
  type SettlementStorePort,
} from './stores.js';
import { reconcile, type ReconcileOptions, type ReconciliationReport } from './reconciliation.js';
import type { LivenessAlert, LivenessMonitor, LivenessState } from './liveness.js';
import { DecisionLog } from './decision-log.js';
import { ApprovalService } from './approvals.js';

/** The shape an SDK/client submits. Server-assigned fields are optional. */
export const IntentInput = z.object({
  id: IntentId.optional(),
  agentId: AgentId,
  vendor: Vendor,
  resource: z.string(),
  amount: DecimalString,
  asset: Asset,
  chain: Chain,
  taskContext: TaskContext.optional(),
  nonce: z.string().min(1).optional(),
  createdAt: z.coerce.date().optional(),
});
export type IntentInput = z.input<typeof IntentInput>;

export interface EvaluateOutput {
  intent: PaymentIntent;
  decision: Decision;
  /**
   * Present only when the decision escalated AND an approval service is
   * configured: the parked request a signed verdict can resolve. Its absence
   * on an `escalate` outcome means nothing can approve this payment — the
   * caller is blocked, full stop.
   */
  approval?: ApprovalRequest;
}

/** What a resolved escalation produced: the terminal record and its decision. */
export interface ResolveOutput {
  request: ApprovalRequest;
  decision: Decision;
}

/** One breaker's current standing for one agent (console observability). */
export interface BreakerState {
  breaker: Breaker;
  policyId: string;
  /** Prior transactions and prior spend inside the measured span. */
  txCount: number;
  sum: string;
  /** Epoch ms the span starts at — the later of window start and last reset. */
  countingFrom: number;
  /** Present when a signed approval moved the floor. */
  resetAt?: number;
  tripped: boolean;
  /** Why, when tripped — the same text a human sees in the challenge. */
  reason?: string;
}

/** Which world to read breaker standing in (see `breakerStates`). */
export interface BreakerStateOptions {
  /** Selects the policy, when policies are chain-scoped. Defaults to `base`. */
  chain?: Chain;
  /** Injected clock, so window arithmetic is testable. */
  now?: number;
}

/** The persistence seams the engine composes over (in-memory when omitted). */
export interface EngineStores {
  spend?: SpendStorePort;
  policies?: PolicyStorePort;
  agents?: AgentRegistryPort;
  /**
   * Settlement facts, for reconciliation (B1). In-memory when omitted — which
   * on a durable deployment means every allowance resumed from disk reads as
   * unsettled after a restart, the false-alarm storm that lands on exactly
   * the deployment with state worth watching. Pass the durable one.
   */
  settlements?: SettlementStorePort;
  /** Pre-built decision log (e.g. persistent key + resumed chain from @reinconsole/store). */
  log?: DecisionLog;
  /**
   * Human-in-the-loop approvals. Omit and `escalate` stays a hard block: the
   * SDK raises, nothing is parked, and no signature can change the outcome.
   */
  approvals?: ApprovalService;
  /**
   * Dead-man monitoring (B2). Omit and the engine watches nobody: no sighting
   * is written on the evaluate path, and `watchLiveness` refuses. Present, it
   * still governs nothing — an alarm is news, never an input to a decision.
   */
  liveness?: LivenessMonitor;
}

/**
 * The policy engine: normalizes intents, applies the kill-switch, evaluates
 * policy, writes a signed decision, emits events, and (on ALLOW) records the
 * spend so rolling budgets/velocity update. Stores are injectable: in-memory
 * by default, durable via @reinconsole/store. Writes are awaited before returning;
 * evaluations are serialized so concurrent intents cannot read a rolling
 * budget before an earlier allow has recorded its spend.
 */
export class PolicyEngine {
  readonly spend: SpendStorePort;
  readonly policies: PolicyStorePort;
  readonly agents: AgentRegistryPort;
  readonly settlements: SettlementStorePort;
  /** Undefined when no approval tier is configured (see EngineStores.approvals). */
  readonly approvals: ApprovalService | undefined;
  /** Undefined when nothing is watching for silence (see EngineStores.liveness). */
  readonly liveness: LivenessMonitor | undefined;
  private readonly log: DecisionLog;
  private readonly bus = new EventEmitter();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(stores: EngineStores = {}) {
    this.spend = stores.spend ?? new InMemorySpendStore();
    this.policies = stores.policies ?? new InMemoryPolicyStore();
    this.agents = stores.agents ?? new InMemoryAgentRegistry();
    this.settlements = stores.settlements ?? new InMemorySettlementStore();
    this.log = stores.log ?? new DecisionLog();
    this.approvals = stores.approvals;
    this.liveness = stores.liveness;
  }

  get publicKeyPem(): string {
    return this.log.publicKeyPem;
  }

  onEvent(handler: (event: ReinEvent) => void): void {
    this.bus.on('event', handler);
  }

  private emit(event: ReinEvent): void {
    this.bus.emit('event', event);
  }

  async registerAgent(input: z.input<typeof Agent>): Promise<Agent> {
    const agent = Agent.parse(input);
    await this.agents.register(agent);
    return agent;
  }

  async addPolicy(input: z.input<typeof Policy>): Promise<Policy> {
    const policy = Policy.parse(input);
    await this.policies.add(policy);
    return policy;
  }

  async freeze(agentId: string): Promise<void> {
    await this.agents.freeze(agentId);
  }

  async unfreeze(agentId: string): Promise<void> {
    await this.agents.unfreeze(agentId);
  }

  private normalize(input: IntentInput): PaymentIntent {
    return PaymentIntent.parse({
      id: input.id ?? newId('int'),
      agentId: input.agentId,
      vendor: input.vendor,
      resource: input.resource,
      amount: input.amount,
      asset: input.asset,
      chain: input.chain,
      taskContext: input.taskContext ?? {},
      nonce: input.nonce ?? newId('non'),
      createdAt: input.createdAt ?? new Date(),
    });
  }

  evaluateIntent(input: IntentInput): Promise<EvaluateOutput> {
    const run = this.tail.then(() => this.evaluateSerialized(input));
    this.tail = run.catch(() => undefined); // a failed evaluate must not wedge the queue
    return run;
  }

  private async evaluateSerialized(input: IntentInput): Promise<EvaluateOutput> {
    const start = performance.now();
    const intent = this.normalize(input);
    this.emit({ type: 'intent.created', at: new Date(), intent });

    let result: EvaluationResult;
    if (this.agents.isFrozen(intent.agentId)) {
      result = {
        outcome: 'deny',
        matchedRules: ['agent-frozen'],
        reason: 'agent is frozen (kill switch)',
        policyId: 'system',
        policyVersion: '0',
      };
    } else {
      const ctx = this.spend.contextFor(intent.agentId, intent.createdAt.getTime());
      // The agent document (labels) rides along so appliesTo.labels can match;
      // unregistered agents pass undefined and never match a labels policy.
      result = evaluate(intent, this.policies.list(), ctx, this.agents.get(intent.agentId));
    }

    const latencyMs = performance.now() - start;
    const intentHash = createHash('sha256').update(canonicalIntent(intent)).digest('hex');
    const decision = await this.log.append({
      ...result,
      intentId: intent.id,
      intentHash,
      latencyMs,
    });
    this.emit({ type: 'decision.made', at: new Date(), decision });

    if (decision.outcome === 'allow') {
      await this.recordSpend(
        {
          agentId: intent.agentId,
          host: intent.vendor.host,
          resource: intent.resource,
          amount: intent.amount,
          taskId: intent.taskContext.taskId,
          intentId: intent.id,
          decisionId: decision.id,
        },
        intent.createdAt.getTime(),
      );
    }

    // The dead-man sighting (B2), recorded for EVERY outcome — a denied intent
    // is an agent that is alive and blocked, which is a different alarm with a
    // different remedy. Folding denials out would make a policy change double
    // as a liveness alarm, and would report a hard-blocked agent as dead.
    await this.sight(intent.agentId, 'intent', intent.createdAt.getTime());

    if (decision.outcome === 'escalate' && this.approvals) {
      const request = await this.approvals.open(intent, decision, {
        breakers: result.breakers ?? [],
      });
      this.emit({ type: 'approval.requested', at: new Date(), request });
      return { intent, decision, approval: request };
    }

    return { intent, decision };
  }

  /**
   * Optimistically count the spend; the indexer confirms settlement later.
   *
   * The record carries its intent and decision ids, which is what makes this
   * ledger the ALLOWANCE ledger reconciliation joins against settlements — no
   * second table, and every budget the engine charged is a row that must
   * eventually be answered for. The optimism is deliberate and stays: an
   * allowance that never settles keeps its charge (see reconciliation.ts).
   */
  private async recordSpend(
    facts: {
      agentId: string;
      host: string;
      resource: string;
      amount: string;
      taskId?: string | undefined;
      intentId: string;
      decisionId: string;
    },
    at: number,
  ): Promise<void> {
    await this.spend.record({
      agentId: facts.agentId,
      host: facts.host,
      resource: facts.resource,
      amount: facts.amount,
      ...(facts.taskId ? { taskId: facts.taskId } : {}),
      intentId: facts.intentId,
      decisionId: facts.decisionId,
      at,
    });
  }

  /**
   * Record that an allowed payment actually landed.
   *
   * The engine watches no chain, so settlement is something it is TOLD: by an
   * indexer, a facilitator webhook, or the guard that made the payment. The
   * write closes a reconciliation gap and nothing else — it cannot authorize
   * spend, alter a decision, or unblock anything. Idempotent by intent id,
   * first report winning, so two observers of one payment agree.
   */
  async recordSettlement(input: z.input<typeof SettlementReport>): Promise<SettlementReport> {
    const report = SettlementReport.parse(input);
    await this.settlements.settle({
      intentId: report.intentId,
      at: report.confirmedAt.getTime(),
      ...(report.txHash !== undefined ? { txHash: report.txHash } : {}),
      ...(report.chain !== undefined ? { chain: report.chain } : {}),
      ...(report.amount !== undefined ? { amount: report.amount } : {}),
      ...(report.source !== undefined ? { source: report.source } : {}),
    });
    return report;
  }

  /**
   * Which allowances in the window have no settlement behind them (B1).
   *
   * Read-only, like {@link breakerStates}: nothing about evaluation depends on
   * it, and running it changes nothing. See reconciliation.ts for why an
   * unsettled allowance keeps its charge against the budget.
   */
  reconcile(options: ReconcileOptions = {}): ReconciliationReport {
    return reconcile(this.spend, this.settlements, options);
  }

  /**
   * Apply a signed verdict to a parked escalation.
   *
   * The escalating decision is never rewritten — the log is append-only and
   * hash-chained, and a rewritten decision would break every verifier. The
   * resolution appends a NEW decision for the same intent, and THAT decision
   * is the voucher a signer accepts: it carries the same `intentHash`, so the
   * {intent, decision} pair still verifies offline as a self-contained
   * authorization of exactly this transfer.
   *
   * Runs on the same serialization queue as evaluation, so an approval that
   * converts to an allow records its spend before any later intent reads a
   * rolling budget — and two grants racing on one request cannot both win.
   */
  resolveEscalation(grant: ApprovalGrant): Promise<ResolveOutput> {
    const run = this.tail.then(() => this.resolveSerialized(grant));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async resolveSerialized(grant: ApprovalGrant): Promise<ResolveOutput> {
    const approvals = this.requireApprovals();
    const start = performance.now();
    const { request, approver, verdict } = approvals.verify(grant);
    const approved = verdict === 'approve';

    const decision = await this.log.append({
      intentId: request.intentId,
      intentHash: request.intentHash,
      outcome: approved ? 'allow' : 'deny',
      matchedRules: [`approver:${approver.id}`],
      reason: `${approved ? 'approved' : 'rejected'} by ${approver.name} (${approver.id}); escalation ${request.decisionId}`,
      policyId: 'approval',
      policyVersion: '1',
      latencyMs: performance.now() - start,
    });
    this.emit({ type: 'decision.made', at: new Date(), decision });

    if (approved) {
      const at = Date.now();
      // A human waving this payment through also clears the behavior that
      // stopped it. Reset FIRST: the reset moves each tripped breaker's
      // counting floor to now, so the spend recorded a line later starts the
      // new window rather than landing behind the floor and being ignored.
      for (const breakerId of request.breakers) {
        await this.spend.resetBreaker(request.agentId, breakerId, at);
      }
      // Counted at approval time, not at park time: an escalation may have sat
      // for most of its TTL, and the money moves now — so this is the instant
      // the rolling windows should age from.
      await this.recordSpend(
        {
          agentId: request.agentId,
          host: request.vendorHost,
          resource: request.resource,
          amount: request.amount,
          taskId: request.taskId,
          // The RELEASING decision, not the escalation it answered: this row
          // is the allowance, and reconciliation joins on the intent — which
          // both decisions share, so one settlement closes it either way.
          intentId: request.intentId,
          decisionId: decision.id,
        },
        at,
      );
    }

    const settled = await approvals.settle(request.decisionId, {
      status: approved ? 'approved' : 'rejected',
      finalDecisionId: decision.id,
      approverKeyId: approver.id,
    });
    this.emit({ type: 'approval.resolved', at: new Date(), request: settled, decision });
    return { request: settled, decision };
  }

  /**
   * Convert every lapsed escalation into a deny. Expiry is a denial, not a
   * quiet drop: the deny lands on the chain so the audit shows what happened
   * to a payment nobody answered for.
   *
   * Correctness does not depend on this running — a lapsed request refuses
   * every signature on its own. The sweep is what makes the denial VISIBLE
   * promptly; the standalone server runs it on an interval.
   */
  sweepEscalations(now?: number): Promise<ResolveOutput[]> {
    const run = this.tail.then(() => this.sweepSerialized(now));
    this.tail = run.catch(() => undefined);
    return run;
  }

  private async sweepSerialized(now?: number): Promise<ResolveOutput[]> {
    const approvals = this.approvals;
    if (!approvals) return [];
    const out: ResolveOutput[] = [];
    for (const request of approvals.lapsed(now)) {
      const start = performance.now();
      const decision = await this.log.append({
        intentId: request.intentId,
        intentHash: request.intentHash,
        outcome: 'deny',
        matchedRules: ['escalation-expired'],
        reason: `escalation ${request.decisionId} expired unanswered; denied (fail closed)`,
        policyId: 'approval',
        policyVersion: '1',
        latencyMs: performance.now() - start,
      });
      this.emit({ type: 'decision.made', at: new Date(), decision });
      const settled = await approvals.settle(request.decisionId, {
        status: 'expired',
        finalDecisionId: decision.id,
      });
      this.emit({ type: 'approval.resolved', at: new Date(), request: settled, decision });
      out.push({ request: settled, decision });
    }
    return out;
  }

  /**
   * Run {@link sweepEscalations} on an interval. Returns the stopper; the
   * timer is unref'd so it never holds a process open.
   */
  startExpirySweeper(intervalMs = 15_000): () => void {
    const timer = setInterval(() => {
      void this.sweepEscalations().catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private requireApprovals(): ApprovalService {
    if (!this.approvals) {
      throw new TypeError('this engine has no approval service; escalations cannot be resolved');
    }
    return this.approvals;
  }

  // --- Dead-man monitoring (B2) ---

  /**
   * Expect this agent to be active at least every `interval`.
   *
   * Watching is DECLARED, never inferred: most agents are episodic, and
   * silence is only evidence about one somebody said should be periodic. An
   * unwatched agent has no liveness state at all — the same shape of rule as
   * a `taskBudget`, which never fires on an intent carrying no task id.
   */
  async watchLiveness(input: LivenessWatchInput): Promise<LivenessExpectation> {
    return this.requireLiveness().watch(input);
  }

  async unwatchLiveness(agentId: string): Promise<boolean> {
    return this.requireLiveness().unwatch(agentId);
  }

  /**
   * Record an out-of-band sighting: the agent is alive and simply has nothing
   * to buy. Every intent is already a sighting, so a spending agent needs none
   * of this; without it, though, a dead-man alarm would really be a no-spend
   * alarm and would page a human over a quiet afternoon.
   *
   * It authorizes nothing. The only thing a heartbeat can change is a row in
   * the liveness report — it cannot lift a breaker, a budget, or a freeze.
   */
  async heartbeat(input: z.input<typeof Heartbeat>): Promise<LivenessState | undefined> {
    const beat = Heartbeat.parse(input);
    const monitor = this.requireLiveness();
    await this.sight(beat.agentId, 'heartbeat', beat.at?.getTime() ?? Date.now());
    return monitor.state(beat.agentId);
  }

  /** Where every watched agent stands right now. Worst first. */
  livenessStates(now?: number): LivenessState[] {
    return this.liveness?.states(now) ?? [];
  }

  /**
   * Raise every newly-missing agent, once each, and emit the events.
   *
   * The only control in Rein driven by something NOT happening, which is why
   * it needs a clock at all: no intent will ever arrive to trigger it. The
   * report from {@link livenessStates} is correct at any instant regardless —
   * the sweep is what makes an alarm ARRIVE.
   */
  async sweepLiveness(now?: number): Promise<LivenessAlert[]> {
    const monitor = this.liveness;
    if (!monitor) return [];
    const raised = await monitor.sweep(now);
    for (const alert of raised) {
      this.emit({
        type: 'liveness.missing',
        at: new Date(alert.at),
        agentId: alert.agentId,
        expectation: alert.expectation,
        silentMs: alert.silentMs,
        ...(alert.lastSeenAt !== undefined ? { lastSeenAt: new Date(alert.lastSeenAt) } : {}),
      });
    }
    return raised;
  }

  /**
   * Run {@link sweepLiveness} on an interval. Returns the stopper; the timer is
   * unref'd so it never holds a process open.
   */
  startLivenessSweeper(intervalMs = 30_000): () => void {
    const timer = setInterval(() => {
      void this.sweepLiveness().catch(() => undefined);
    }, intervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }

  /** Write a sighting if anyone is watching. Never throws — see the monitor. */
  private async sight(
    agentId: string,
    source: 'intent' | 'heartbeat',
    at: number,
  ): Promise<void> {
    const recovery = await this.liveness?.seen(agentId, source, at);
    if (!recovery) return;
    this.emit({
      type: 'liveness.recovered',
      at: new Date(recovery.at),
      agentId: recovery.agentId,
      silentMs: recovery.silentMs,
      source: recovery.source,
    });
  }

  private requireLiveness(): LivenessMonitor {
    if (!this.liveness) {
      throw new TypeError('this engine has no liveness monitor; nothing is being watched');
    }
    return this.liveness;
  }

  /**
   * Where every breaker that applies to an agent currently stands. Read-only
   * observability — the console renders it, and nothing about evaluation
   * depends on it. `tripped` is measured against a zero-value probe, so it
   * answers "has the agent already left the envelope?" rather than "would
   * this specific payment leave it?".
   *
   * Policy selection is first-applicable, exactly as in evaluation — which
   * means a chain-scoped policy needs `options.chain` to be found. The
   * default matches the default an intent carries.
   */
  breakerStates(agentId: string, options: BreakerStateOptions = {}): BreakerState[] {
    const now = options.now ?? Date.now();
    const agent = this.agents.get(agentId);
    const probe = PaymentIntent.parse({
      id: newId('int'),
      agentId,
      vendor: { host: 'breaker.probe.invalid', address: '0x0' },
      resource: '/',
      amount: '0',
      asset: 'USDC',
      chain: options.chain ?? 'base',
      taskContext: {},
      nonce: 'probe',
      createdAt: new Date(now),
    });
    const policy = this.policies.list().find((p) => policyApplies(p, probe, agent));
    if (!policy) return [];
    const ctx = this.spend.contextFor(agentId, now);
    const resets = this.spend.breakerResets(agentId);
    return policy.breakers.map((breaker) => {
      const window = ctx.breakerWindow(breaker.id, breaker.window);
      const tripped = breakerTrips(breaker, probe, ctx);
      return {
        breaker,
        policyId: policy.policyId,
        txCount: window.txCount,
        sum: window.sum,
        countingFrom: Math.max(now - parseWindowMs(breaker.window), resets[breaker.id] ?? 0),
        ...(resets[breaker.id] !== undefined ? { resetAt: resets[breaker.id] as number } : {}),
        tripped: tripped !== undefined,
        ...(tripped !== undefined ? { reason: tripped } : {}),
      };
    });
  }

  decisions(): readonly Decision[] {
    return this.log.all();
  }
}
