import { describe, it, expect } from 'vitest';
import { newId, type ReinEvent } from '@reinconsole/core';
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
  it('allows under cap and denies over cap', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_cap',
      rules: [{ id: 'hard-cap', deny: { amountGt: '5.00' } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    expect((await engine.evaluateIntent(baseIntent(agentId, '1.00'))).decision.outcome).toBe(
      'allow',
    );
    expect((await engine.evaluateIntent(baseIntent(agentId, '6.00'))).decision.outcome).toBe(
      'deny',
    );
  });

  it('accumulates a rolling budget across allowed payments', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_budget',
      rules: [{ id: 'daily', deny: { rollingSum: { window: '24h', gt: '1.00' } } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    expect((await engine.evaluateIntent(baseIntent(agentId, '0.50'))).decision.outcome).toBe(
      'allow',
    );
    expect((await engine.evaluateIntent(baseIntent(agentId, '0.50'))).decision.outcome).toBe(
      'allow',
    );
    // Third payment pushes prior 1.00 + 0.50 = 1.50 over the 1.00 budget.
    expect((await engine.evaluateIntent(baseIntent(agentId, '0.50'))).decision.outcome).toBe(
      'deny',
    );
  });

  it('enforces a rolling budget even under concurrent evaluation', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_budget',
      rules: [{ id: 'daily', deny: { rollingSum: { window: '24h', gt: '1.00' } } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    // Fired without awaiting in between. Unserialized, all three would read
    // prior spend 0 and allow; serialized, the third sees 1.00 + 0.50 > 1.00.
    const results = await Promise.all(
      ['0.50', '0.50', '0.50'].map((amt) => engine.evaluateIntent(baseIntent(agentId, amt))),
    );
    expect(results.map((r) => r.decision.outcome)).toEqual(['allow', 'allow', 'deny']);
  });

  it('hard-denies a frozen agent (kill switch)', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    const agentId = newId('agt');
    expect((await engine.evaluateIntent(baseIntent(agentId, '0.01'))).decision.outcome).toBe(
      'allow',
    );
    await engine.freeze(agentId);
    const frozen = (await engine.evaluateIntent(baseIntent(agentId, '0.01'))).decision;
    expect(frozen.outcome).toBe('deny');
    expect(frozen.matchedRules).toContain('agent-frozen');
    await engine.unfreeze(agentId);
    expect((await engine.evaluateIntent(baseIntent(agentId, '0.01'))).decision.outcome).toBe(
      'allow',
    );
  });

  /**
   * S66 found the listing reporting `active` for an agent evaluation was
   * already denying: the kill switch lives in its own table and `freeze`
   * never rewrites the agent row. Over HTTP that field is all a remote reader
   * gets — the console cannot consult a table it has no access to — so a
   * stale value there tells an operator the kill switch is off while it is on.
   */
  it('reports a frozen agent as frozen in the listing, not just in evaluation', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    const agent = await engine.registerAgent({
      id: newId('agt'),
      orgId: newId('org'),
      name: 'kill-switched',
      labels: [],
      wallets: [],
      status: 'active',
      createdAt: new Date(),
    });

    expect(engine.visibleAgents().find((a) => a.id === agent.id)?.status).toBe('active');

    await engine.freeze(agent.id);
    expect(engine.visibleAgents().find((a) => a.id === agent.id)?.status).toBe('frozen');
    // The same fact, read the other way — the two must not disagree.
    expect((await engine.evaluateIntent(baseIntent(agent.id, '0.01'))).decision.outcome).toBe(
      'deny',
    );

    await engine.unfreeze(agent.id);
    expect(engine.visibleAgents().find((a) => a.id === agent.id)?.status).toBe('active');
  });

  it('targets policies by agent label through the registry', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_research',
      appliesTo: { labels: ['research'] },
      rules: [{ id: 'cap', deny: { amountGt: '1.00' } }],
      default: 'allow',
    });
    const researcher = newId('agt');
    const drone = newId('agt');
    const at = (id: string, labels: string[]) =>
      engine.registerAgent({
        id,
        orgId: newId('org'),
        name: `agent-${labels[0] ?? 'plain'}`,
        labels,
        createdAt: new Date(),
      });
    await at(researcher, ['research']);
    await at(drone, []);

    const allowed = (await engine.evaluateIntent(baseIntent(researcher, '0.50'))).decision;
    expect(allowed.outcome).toBe('allow');
    expect(allowed.policyId).toBe('pol_research');
    expect((await engine.evaluateIntent(baseIntent(researcher, '2.00'))).decision.outcome).toBe(
      'deny',
    );
    // No matching label — the policy does not apply, so the intent fails
    // closed. Same for an agent the registry has never seen.
    const unlabeled = (await engine.evaluateIntent(baseIntent(drone, '0.50'))).decision;
    expect(unlabeled.outcome).toBe('deny');
    expect(unlabeled.policyId).toBe('none');
    const unregistered = (await engine.evaluateIntent(baseIntent(newId('agt'), '0.50'))).decision;
    expect(unregistered.outcome).toBe('deny');
    expect(unregistered.policyId).toBe('none');
  });

  it('emits intent.created and decision.made events', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    const events: ReinEvent[] = [];
    engine.onEvent((e) => events.push(e));
    await engine.evaluateIntent(baseIntent(newId('agt'), '0.01'));
    expect(events.map((e) => e.type)).toEqual(['intent.created', 'decision.made']);
  });

  it('keeps every decision in a verifiable chain', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_cap',
      rules: [{ id: 'hard-cap', deny: { amountGt: '5.00' } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    for (const amt of ['1', '2', '6', '0.5']) await engine.evaluateIntent(baseIntent(agentId, amt));
    expect(engine.decisions()).toHaveLength(4);
    expect(verifyDecisionChain(engine.decisions(), engine.publicKeyPem)).toBe(true);
  });
});
