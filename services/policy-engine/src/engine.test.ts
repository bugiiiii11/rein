import { describe, it, expect } from 'vitest';
import { newId, type ReinEvent } from '@rein/core';
import { PolicyEngine } from './engine.js';
import { verifyDecisionChain } from './decision-log.js';

function baseIntent(agentId: string, amount: string) {
  return {
    agentId,
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount,
    asset: 'USDC' as const,
    chain: 'base' as const,
  };
}

describe('PolicyEngine', () => {
  it('allows under cap and denies over cap', () => {
    const engine = new PolicyEngine();
    engine.addPolicy({
      policyId: 'pol_cap',
      rules: [{ id: 'hard-cap', deny: { amountGt: '5.00' } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    expect(engine.evaluateIntent(baseIntent(agentId, '1.00')).decision.outcome).toBe('allow');
    expect(engine.evaluateIntent(baseIntent(agentId, '6.00')).decision.outcome).toBe('deny');
  });

  it('accumulates a rolling budget across allowed payments', () => {
    const engine = new PolicyEngine();
    engine.addPolicy({
      policyId: 'pol_budget',
      rules: [{ id: 'daily', deny: { rollingSum: { window: '24h', gt: '1.00' } } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    expect(engine.evaluateIntent(baseIntent(agentId, '0.50')).decision.outcome).toBe('allow');
    expect(engine.evaluateIntent(baseIntent(agentId, '0.50')).decision.outcome).toBe('allow');
    // Third payment pushes prior 1.00 + 0.50 = 1.50 over the 1.00 budget.
    expect(engine.evaluateIntent(baseIntent(agentId, '0.50')).decision.outcome).toBe('deny');
  });

  it('hard-denies a frozen agent (kill switch)', () => {
    const engine = new PolicyEngine();
    engine.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    const agentId = newId('agt');
    expect(engine.evaluateIntent(baseIntent(agentId, '0.01')).decision.outcome).toBe('allow');
    engine.freeze(agentId);
    const frozen = engine.evaluateIntent(baseIntent(agentId, '0.01')).decision;
    expect(frozen.outcome).toBe('deny');
    expect(frozen.matchedRules).toContain('agent-frozen');
    engine.unfreeze(agentId);
    expect(engine.evaluateIntent(baseIntent(agentId, '0.01')).decision.outcome).toBe('allow');
  });

  it('emits intent.created and decision.made events', () => {
    const engine = new PolicyEngine();
    engine.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    const events: ReinEvent[] = [];
    engine.onEvent((e) => events.push(e));
    engine.evaluateIntent(baseIntent(newId('agt'), '0.01'));
    expect(events.map((e) => e.type)).toEqual(['intent.created', 'decision.made']);
  });

  it('keeps every decision in a verifiable chain', () => {
    const engine = new PolicyEngine();
    engine.addPolicy({
      policyId: 'pol_cap',
      rules: [{ id: 'hard-cap', deny: { amountGt: '5.00' } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    for (const amt of ['1', '2', '6', '0.5']) engine.evaluateIntent(baseIntent(agentId, amt));
    expect(engine.decisions()).toHaveLength(4);
    expect(verifyDecisionChain(engine.decisions(), engine.publicKeyPem)).toBe(true);
  });
});
