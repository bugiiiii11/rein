import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { Policy, PaymentIntent, newId, type ApprovalVerdict } from '@reinconsole/core';
import { breakerTrips, evaluate, type SpendContext } from './evaluator.js';
import { PolicyEngine } from './engine.js';
import { ApprovalService, signApproval } from './approvals.js';
import { InMemorySpendStore } from './stores.js';

/**
 * A3 (behavioral breakers) and A4 (per-task budgets).
 *
 * The two invariants these tests exist to defend:
 *   - a breaker ESCALATES, it never denies on its own (a silent deny strands
 *     a running job with no path forward and nobody told);
 *   - a reset is a FLOOR, not a counter wipe — which is why "reset by window
 *     expiry" and "reset by signed approval" are the same operation.
 */

function ctx(overrides: Partial<SpendContext> = {}): SpendContext {
  return {
    rollingSum: () => '0',
    txCount: () => 0,
    taskSum: () => '0',
    breakerWindow: () => ({ txCount: 0, sum: '0' }),
    isVendorFirstSeen: () => false,
    vendorReputation: () => undefined,
    resourceMedian: () => undefined,
    ...overrides,
  };
}

function intent(partial: Record<string, unknown> = {}): PaymentIntent {
  return PaymentIntent.parse({
    id: newId('int'),
    agentId: newId('agt'),
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount: '1.00',
    asset: 'USDC',
    chain: 'base',
    nonce: 'n',
    createdAt: new Date(),
    ...partial,
  });
}

describe('breakerTrips — tripwires are prospective', () => {
  const velocity = { id: 'velocity', window: '1h', txCount: 10 };
  const value = { id: 'value', window: '24h', valueCap: '50.00' };

  it('permits exactly the transaction count it was given', () => {
    const at9 = ctx({ breakerWindow: () => ({ txCount: 9, sum: '0' }) });
    expect(breakerTrips(velocity, intent(), at9)).toBeUndefined();
  });

  it('trips on the transaction that would exceed the count', () => {
    const at10 = ctx({ breakerWindow: () => ({ txCount: 10, sum: '0' }) });
    expect(breakerTrips(velocity, intent(), at10)).toMatch(/11 tx > 10 in 1h/);
  });

  it('permits a window that lands exactly on the value cap', () => {
    const near = ctx({ breakerWindow: () => ({ txCount: 1, sum: '49.00' }) });
    expect(breakerTrips(value, intent({ amount: '1.00' }), near)).toBeUndefined();
  });

  it('trips on the payment that would carry the window past the cap', () => {
    const near = ctx({ breakerWindow: () => ({ txCount: 1, sum: '49.00' }) });
    // Prospective, deliberately: the payment that breaches is the one that
    // escalates — a retrospective check would let it through and stop the
    // innocent one behind it.
    expect(breakerTrips(value, intent({ amount: '1.01' }), near)).toMatch(/50.01 > 50.00/);
  });

  it('ORs its tripwires — either one is enough', () => {
    const both = { id: 'both', window: '1h', txCount: 10, valueCap: '50.00' };
    const busy = ctx({ breakerWindow: () => ({ txCount: 10, sum: '0' }) });
    const rich = ctx({ breakerWindow: () => ({ txCount: 1, sum: '50.00' }) });
    expect(breakerTrips(both, intent({ amount: '0.01' }), busy)).toBeDefined();
    expect(breakerTrips(both, intent({ amount: '0.01' }), rich)).toBeDefined();
  });
});

describe('evaluate — breaker precedence', () => {
  const policy = Policy.parse({
    policyId: 'pol_breaker',
    rules: [
      { id: 'hard-cap', deny: { amountGt: '100.00' } },
      { id: 'trusted-vendor', allow: { vendorHostIn: ['api.example.com'] } },
    ],
    breakers: [{ id: 'velocity', window: '1h', txCount: 3 }],
    default: 'deny',
  });
  const tripped = ctx({ breakerWindow: () => ({ txCount: 3, sum: '0' }) });

  it('a tripped breaker escalates, and no ALLOW rule can wave it past', () => {
    const result = evaluate(intent(), [policy], tripped);
    expect(result.outcome).toBe('escalate');
    expect(result.matchedRules).toContain('breaker:velocity');
    expect(result.breakers).toEqual(['velocity']);
    expect(result.reason).toMatch(/4 tx > 3 in 1h/);
  });

  it('an explicit DENY still beats a tripped breaker', () => {
    const result = evaluate(intent({ amount: '200.00' }), [policy], tripped);
    expect(result.outcome).toBe('deny');
    expect(result.matchedRules).toEqual(['hard-cap']);
  });

  it('an untripped breaker changes nothing', () => {
    const result = evaluate(intent(), [policy], ctx());
    expect(result.outcome).toBe('allow');
    expect(result.breakers ?? []).toEqual([]);
  });

  it('names both the rule and the breaker when both escalate', () => {
    const mixed = Policy.parse({
      policyId: 'pol_mixed',
      rules: [{ id: 'novel-vendor', escalate: { vendorFirstSeen: true } }],
      breakers: [{ id: 'velocity', window: '1h', txCount: 3 }],
      default: 'allow',
    });
    const result = evaluate(
      intent(),
      [mixed],
      ctx({
        breakerWindow: () => ({ txCount: 3, sum: '0' }),
        isVendorFirstSeen: () => true,
      }),
    );
    expect(result.matchedRules).toEqual(['novel-vendor', 'breaker:velocity']);
    expect(result.breakers).toEqual(['velocity']);
  });
});

describe('taskBudget — A4', () => {
  const policy = Policy.parse({
    policyId: 'pol_task',
    rules: [
      { id: 'task-cap', escalate: { taskBudget: { gt: '5.00' } } },
      { id: 'untagged', deny: { taskIdMissing: true } },
    ],
    default: 'allow',
  });

  it('escalates the payment that would carry the task past its budget', () => {
    const spent = ctx({ taskSum: () => '4.50' });
    const result = evaluate(intent({ taskContext: { taskId: 't1' }, amount: '0.51' }), [policy], spent);
    expect(result.outcome).toBe('escalate');
    expect(result.matchedRules).toEqual(['task-cap']);
  });

  it('permits a task landing exactly on its budget', () => {
    const spent = ctx({ taskSum: () => '4.50' });
    const result = evaluate(intent({ taskContext: { taskId: 't1' }, amount: '0.50' }), [policy], spent);
    expect(result.outcome).toBe('allow');
  });

  it('never triggers for an intent with no task id — attribution is a separate rule', () => {
    // The untagged intent is denied by `taskIdMissing`, NOT by the budget:
    // an unattributable probe payment must not trip every task budget.
    const spent = ctx({ taskSum: () => '999.00' });
    const result = evaluate(intent({ amount: '0.01' }), [policy], spent);
    expect(result.outcome).toBe('deny');
    expect(result.matchedRules).toEqual(['untagged']);
  });

  it('budgets are per task, not per agent', async () => {
    const store = new InMemorySpendStore();
    await store.record({ agentId: 'a', host: 'h', resource: '/r', amount: '9.00', at: 1, taskId: 't1' });
    const spend = store.contextFor('a', 1000);
    expect(spend.taskSum('t1')).toBe('9');
    expect(spend.taskSum('t2')).toBe('0');
  });
});

// --- engine-level: trip, escalate, approve, reset ---

function grantFor(
  request: { decisionId: string; intentHash: string },
  approverKeyId: string,
  privateKey: KeyObject,
  verdict: ApprovalVerdict,
) {
  return {
    decisionId: request.decisionId,
    intentHash: request.intentHash,
    verdict,
    approverKeyId,
    signature: signApproval(privateKey, {
      decisionId: request.decisionId,
      intentHash: request.intentHash,
      verdict,
    }),
  };
}

async function breakerEngine(breakers: Policy['breakers']) {
  const approvals = new ApprovalService();
  const spend = new InMemorySpendStore();
  const engine = new PolicyEngine({ approvals, spend });
  await engine.addPolicy({ policyId: 'pol_breaker', breakers, default: 'allow' });
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const approver = await approvals.registerApprover({
    orgId: newId('org'),
    name: 'Finance',
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  });
  return { engine, spend, approver, privateKey };
}

function pay(agentId: string, amount = '1.00', createdAt?: Date, taskId?: string) {
  return {
    agentId,
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount,
    asset: 'USDC' as const,
    chain: 'base' as const,
    ...(createdAt ? { createdAt } : {}),
    ...(taskId ? { taskContext: { taskId } } : {}),
  };
}

describe('breakers end-to-end through the engine', () => {
  it('allows up to the tripwire, then escalates every subsequent intent', async () => {
    const { engine } = await breakerEngine([{ id: 'velocity', window: '1h', txCount: 3 }]);
    const agentId = newId('agt');

    for (let i = 0; i < 3; i += 1) {
      const { decision } = await engine.evaluateIntent(pay(agentId));
      expect(decision.outcome).toBe('allow');
    }
    const fourth = await engine.evaluateIntent(pay(agentId));
    expect(fourth.decision.outcome).toBe('escalate');
    expect(fourth.approval?.breakers).toEqual(['velocity']);

    // Still tripped: a breaker gates the behavior, not one transaction.
    const fifth = await engine.evaluateIntent(pay(agentId));
    expect(fifth.decision.outcome).toBe('escalate');
  });

  it('a signed approval resets the breaker, so the next intent flows again', async () => {
    const { engine, approver, privateKey } = await breakerEngine([
      { id: 'velocity', window: '1h', txCount: 2 },
    ]);
    const agentId = newId('agt');
    await engine.evaluateIntent(pay(agentId));
    await engine.evaluateIntent(pay(agentId));

    const blocked = await engine.evaluateIntent(pay(agentId));
    expect(blocked.decision.outcome).toBe('escalate');
    const request = blocked.approval;
    expect(request).toBeDefined();

    const resolved = await engine.resolveEscalation(
      grantFor(request!, approver.id, privateKey, 'approve'),
    );
    expect(resolved.decision.outcome).toBe('allow');

    const states = engine.breakerStates(agentId);
    expect(states[0]?.tripped).toBe(false);
    // The reset is a floor, not a wipe: the approved payment itself lands
    // AFTER the floor and is counted in the new window.
    expect(states[0]?.txCount).toBe(1);
    expect(states[0]?.resetAt).toBeDefined();

    const next = await engine.evaluateIntent(pay(agentId));
    expect(next.decision.outcome).toBe('allow');
  });

  it('a rejected approval does not reset the breaker', async () => {
    const { engine, approver, privateKey } = await breakerEngine([
      { id: 'velocity', window: '1h', txCount: 1 },
    ]);
    const agentId = newId('agt');
    await engine.evaluateIntent(pay(agentId));
    const blocked = await engine.evaluateIntent(pay(agentId));

    const resolved = await engine.resolveEscalation(
      grantFor(blocked.approval!, approver.id, privateKey, 'reject'),
    );
    expect(resolved.decision.outcome).toBe('deny');
    expect(engine.breakerStates(agentId)[0]?.tripped).toBe(true);
  });

  it('the window rolling forward resets a breaker with no human involved', async () => {
    const { engine } = await breakerEngine([{ id: 'velocity', window: '1h', txCount: 2 }]);
    const agentId = newId('agt');
    const t0 = new Date('2026-09-09T00:00:00Z');
    await engine.evaluateIntent(pay(agentId, '1.00', t0));
    await engine.evaluateIntent(pay(agentId, '1.00', t0));
    const blocked = await engine.evaluateIntent(pay(agentId, '1.00', t0));
    expect(blocked.decision.outcome).toBe('escalate');

    const later = new Date(t0.getTime() + 2 * 3_600_000);
    const after = await engine.evaluateIntent(pay(agentId, '1.00', later));
    expect(after.decision.outcome).toBe('allow');
  });

  it('a value breaker escalates the payment that would breach the cap', async () => {
    const { engine } = await breakerEngine([{ id: 'value', window: '24h', valueCap: '10.00' }]);
    const agentId = newId('agt');
    const first = await engine.evaluateIntent(pay(agentId, '10.00'));
    expect(first.decision.outcome).toBe('allow');
    const second = await engine.evaluateIntent(pay(agentId, '0.01'));
    expect(second.decision.outcome).toBe('escalate');
    expect(second.decision.reason).toMatch(/10.01 > 10.00 in 24h/);
  });

  it('an approved escalation still counts against its task budget', async () => {
    const approvals = new ApprovalService();
    const spend = new InMemorySpendStore();
    const engine = new PolicyEngine({ approvals, spend });
    await engine.addPolicy({
      policyId: 'pol_task',
      rules: [{ id: 'task-cap', escalate: { taskBudget: { gt: '2.00' } } }],
      default: 'allow',
    });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const approver = await approvals.registerApprover({
      orgId: newId('org'),
      name: 'Finance',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    const agentId = newId('agt');

    await engine.evaluateIntent(pay(agentId, '2.00', undefined, 'task-1'));
    const blocked = await engine.evaluateIntent(pay(agentId, '1.00', undefined, 'task-1'));
    expect(blocked.decision.outcome).toBe('escalate');
    expect(blocked.approval?.taskId).toBe('task-1');

    await engine.resolveEscalation(grantFor(blocked.approval!, approver.id, privateKey, 'approve'));
    // The approved payment must land on the task's ledger; if it did not, the
    // budget would silently under-count exactly the payments a human saw.
    expect(spend.contextFor(agentId).taskSum('task-1')).toBe('3');
  });

  it('an expired escalation leaves the breaker tripped (fail closed)', async () => {
    let now = Date.now();
    const approvals = new ApprovalService({ ttlMs: 1_000, now: () => now });
    const engine = new PolicyEngine({ approvals });
    await engine.addPolicy({
      policyId: 'pol_breaker',
      breakers: [{ id: 'velocity', window: '1h', txCount: 1 }],
      default: 'allow',
    });
    const agentId = newId('agt');
    await engine.evaluateIntent(pay(agentId));
    await engine.evaluateIntent(pay(agentId));

    now += 2_000;
    const swept = await engine.sweepEscalations(now);
    expect(swept).toHaveLength(1);
    expect(swept[0]?.decision.outcome).toBe('deny');
    expect(engine.breakerStates(agentId)[0]?.tripped).toBe(true);
  });

  it('breakerStates reports standing without an approval service configured', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_breaker',
      breakers: [{ id: 'velocity', window: '1h', txCount: 2 }],
      default: 'allow',
    });
    const agentId = newId('agt');
    expect(engine.breakerStates(agentId)).toHaveLength(1);
    expect(engine.breakerStates(agentId)[0]?.tripped).toBe(false);

    await engine.evaluateIntent(pay(agentId, '1.50'));
    await engine.evaluateIntent(pay(agentId, '1.50'));
    const [state] = engine.breakerStates(agentId);
    expect(state?.txCount).toBe(2);
    expect(state?.sum).toBe('3');
    expect(state?.tripped).toBe(true);
    // No approval service: escalate is a hard block, nothing parked.
    const blocked = await engine.evaluateIntent(pay(agentId));
    expect(blocked.decision.outcome).toBe('escalate');
    expect(blocked.approval).toBeUndefined();
  });

  it('needs the chain to find a chain-scoped policy (same selection as evaluation)', async () => {
    const engine = new PolicyEngine();
    const agentId = newId('agt');
    await engine.addPolicy({
      policyId: 'pol_polygon',
      appliesTo: { chains: ['polygon'] },
      breakers: [{ id: 'velocity', window: '1h', txCount: 2 }],
      default: 'allow',
    });
    expect(engine.breakerStates(agentId)).toEqual([]);
    expect(engine.breakerStates(agentId, { chain: 'polygon' })).toHaveLength(1);
  });

  it('returns no breaker state for an agent no policy applies to', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_scoped',
      appliesTo: { agents: ['agt_research_*'] },
      breakers: [{ id: 'velocity', window: '1h', txCount: 2 }],
      default: 'allow',
    });
    expect(engine.breakerStates(newId('agt'))).toEqual([]);
  });
});

describe('Breaker schema', () => {
  it('requires at least one tripwire', () => {
    expect(() =>
      Policy.parse({ policyId: 'p', breakers: [{ id: 'b', window: '1h' }] }),
    ).toThrow();
  });

  it('rejects a malformed window', () => {
    expect(() =>
      Policy.parse({ policyId: 'p', breakers: [{ id: 'b', window: '1 hour', txCount: 1 }] }),
    ).toThrow();
  });

  it('defaults to no breakers', () => {
    expect(Policy.parse({ policyId: 'p' }).breakers).toEqual([]);
  });
});
