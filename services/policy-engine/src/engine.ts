import { EventEmitter } from 'node:events';
import { performance } from 'node:perf_hooks';
import { z } from 'zod';
import {
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
import { InMemorySpendStore, InMemoryPolicyStore, InMemoryAgentRegistry } from './stores.js';
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

/**
 * The policy engine: normalizes intents, applies the kill-switch, evaluates
 * policy, writes a signed decision, emits events, and (on ALLOW) records the
 * spend so rolling budgets/velocity update. Fully in-memory for v0.1.
 */
export class PolicyEngine {
  readonly spend = new InMemorySpendStore();
  readonly policies = new InMemoryPolicyStore();
  readonly agents = new InMemoryAgentRegistry();
  private readonly log = new DecisionLog();
  private readonly bus = new EventEmitter();

  get publicKeyPem(): string {
    return this.log.publicKeyPem;
  }

  onEvent(handler: (event: ReinEvent) => void): void {
    this.bus.on('event', handler);
  }

  private emit(event: ReinEvent): void {
    this.bus.emit('event', event);
  }

  registerAgent(input: z.input<typeof Agent>): Agent {
    const agent = Agent.parse(input);
    this.agents.register(agent);
    return agent;
  }

  addPolicy(input: z.input<typeof Policy>): Policy {
    const policy = Policy.parse(input);
    this.policies.add(policy);
    return policy;
  }

  freeze(agentId: string): void {
    this.agents.freeze(agentId);
  }

  unfreeze(agentId: string): void {
    this.agents.unfreeze(agentId);
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

  evaluateIntent(input: IntentInput): EvaluateOutput {
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
    const decision = this.log.append({ ...result, intentId: intent.id, latencyMs });
    this.emit({ type: 'decision.made', at: new Date(), decision });

    if (decision.outcome === 'allow') {
      // Optimistically count the spend; the indexer confirms settlement later.
      this.spend.record({
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
