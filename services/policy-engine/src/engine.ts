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
  type Decision,
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
  parseWindowMs,
  type SpendStorePort,
  type PolicyStorePort,
  type AgentRegistryPort,
} from './stores.js';
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
  /** Pre-built decision log (e.g. persistent key + resumed chain from @reinconsole/store). */
  log?: DecisionLog;
  /**
   * Human-in-the-loop approvals. Omit and `escalate` stays a hard block: the
   * SDK raises, nothing is parked, and no signature can change the outcome.
   */
  approvals?: ApprovalService;
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
  /** Undefined when no approval tier is configured (see EngineStores.approvals). */
  readonly approvals: ApprovalService | undefined;
  private readonly log: DecisionLog;
  private readonly bus = new EventEmitter();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(stores: EngineStores = {}) {
    this.spend = stores.spend ?? new InMemorySpendStore();
    this.policies = stores.policies ?? new InMemoryPolicyStore();
    this.agents = stores.agents ?? new InMemoryAgentRegistry();
    this.log = stores.log ?? new DecisionLog();
    this.approvals = stores.approvals;
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
        },
        intent.createdAt.getTime(),
      );
    }

    if (decision.outcome === 'escalate' && this.approvals) {
      const request = await this.approvals.open(intent, decision, {
        breakers: result.breakers ?? [],
      });
      this.emit({ type: 'approval.requested', at: new Date(), request });
      return { intent, decision, approval: request };
    }

    return { intent, decision };
  }

  /** Optimistically count the spend; the indexer confirms settlement later. */
  private async recordSpend(
    facts: {
      agentId: string;
      host: string;
      resource: string;
      amount: string;
      taskId?: string | undefined;
    },
    at: number,
  ): Promise<void> {
    await this.spend.record({
      agentId: facts.agentId,
      host: facts.host,
      resource: facts.resource,
      amount: facts.amount,
      ...(facts.taskId ? { taskId: facts.taskId } : {}),
      at,
    });
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
