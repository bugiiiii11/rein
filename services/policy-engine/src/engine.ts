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
  type Decision,
  type ReinEvent,
} from '@rein/core';
import { evaluate, type EvaluationResult } from './evaluator.js';
import {
  InMemorySpendStore,
  InMemoryPolicyStore,
  InMemoryAgentRegistry,
  type SpendStorePort,
  type PolicyStorePort,
  type AgentRegistryPort,
} from './stores.js';
import { DecisionLog } from './decision-log.js';

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
}

/** The persistence seams the engine composes over (in-memory when omitted). */
export interface EngineStores {
  spend?: SpendStorePort;
  policies?: PolicyStorePort;
  agents?: AgentRegistryPort;
  /** Pre-built decision log (e.g. persistent key + resumed chain from @rein/store). */
  log?: DecisionLog;
}

/**
 * The policy engine: normalizes intents, applies the kill-switch, evaluates
 * policy, writes a signed decision, emits events, and (on ALLOW) records the
 * spend so rolling budgets/velocity update. Stores are injectable: in-memory
 * by default, durable via @rein/store. Writes are awaited before returning;
 * evaluations are serialized so concurrent intents cannot read a rolling
 * budget before an earlier allow has recorded its spend.
 */
export class PolicyEngine {
  readonly spend: SpendStorePort;
  readonly policies: PolicyStorePort;
  readonly agents: AgentRegistryPort;
  private readonly log: DecisionLog;
  private readonly bus = new EventEmitter();
  private tail: Promise<unknown> = Promise.resolve();

  constructor(stores: EngineStores = {}) {
    this.spend = stores.spend ?? new InMemorySpendStore();
    this.policies = stores.policies ?? new InMemoryPolicyStore();
    this.agents = stores.agents ?? new InMemoryAgentRegistry();
    this.log = stores.log ?? new DecisionLog();
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
      result = evaluate(intent, this.policies.list(), ctx);
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
      // Optimistically count the spend; the indexer confirms settlement later.
      await this.spend.record({
        agentId: intent.agentId,
        host: intent.vendor.host,
        resource: intent.resource,
        amount: intent.amount,
        at: intent.createdAt.getTime(),
      });
    }

    return { intent, decision };
  }

  decisions(): readonly Decision[] {
    return this.log.all();
  }
}
