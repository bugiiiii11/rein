import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { newId, type ApprovalVerdict } from '@reinconsole/core';
import { PolicyEngine } from './engine.js';
import { ApprovalService, signApproval } from './approvals.js';
import { InMemorySettlementStore, InMemorySpendStore } from './stores.js';
import { reconcile } from './reconciliation.js';

/**
 * B1 — "allowed but never settled".
 *
 * The invariants these tests exist to defend:
 *   - an unsettled allowance KEEPS its charge against the budget (refunding it
 *     would be a self-service reset: don't settle, and the envelope refills);
 *   - a gap has an AGE — under the grace period a missing settlement is a
 *     payment in flight, which is the normal state of every payment;
 *   - reconciliation is observability, never authority: running it changes no
 *     decision, and a settlement report authorizes nothing.
 */

function baseIntent(agentId: string, amount = '1.00') {
  return {
    agentId,
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount,
    asset: 'USDC' as const,
    chain: 'base' as const,
  };
}

/**
 * `clock` moves the engine's time. Allowances used to be aged by dating the
 * intent, which is request-body input: the same field let a caller stamp a
 * spend outside every window that would have counted it, so reconciliation
 * never saw it either.
 */
async function allowingEngine(clock?: { now: number }) {
  const engine = new PolicyEngine(clock ? { now: () => clock.now } : {});
  await engine.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
  return engine;
}

function grant(
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

describe('the join', () => {
  it('reports an allowance with no settlement, and closes it when one arrives', async () => {
    const engine = await allowingEngine();
    const agentId = newId('agt');
    const { intent } = await engine.evaluateIntent(baseIntent(agentId, '2.50'));

    const before = engine.reconcile({ graceMs: 0 });
    expect(before.allowed).toBe(1);
    expect(before.unsettled).toBe(1);
    expect(Number(before.unsettledValue)).toBeCloseTo(2.5);
    expect(before.settlementsSeen).toBe(0);
    expect(before.gaps[0]?.intentId).toBe(intent.id);
    expect(before.gaps[0]?.host).toBe('api.example.com');

    await engine.recordSettlement({
      intentId: intent.id,
      txHash: '0xabc',
      source: 'indexer',
      confirmedAt: new Date(),
    });

    const after = engine.reconcile({ graceMs: 0 });
    expect(after.unsettled).toBe(0);
    expect(after.settled).toBe(1);
    expect(Number(after.settledValue)).toBeCloseTo(2.5);
    expect(after.settlementsSeen).toBe(1);
    expect(after.gaps).toEqual([]);
  });

  it('counts only ALLOWED payments — a deny authorized nothing to settle', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_cap',
      rules: [{ id: 'tx-cap', deny: { amountGt: '1.00' } }],
      default: 'allow',
    });
    await engine.evaluateIntent(baseIntent(newId('agt'), '5.00'));

    const report = engine.reconcile({ graceMs: 0 });
    expect(report.allowed).toBe(0);
    expect(report.gaps).toEqual([]);
  });

  it('does NOT refund the budget: the unsettled allowance still counts against it', async () => {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_budget',
      rules: [{ id: 'hour-budget', deny: { rollingSum: { window: '1h', gt: '1.00' } } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    await engine.evaluateIntent(baseIntent(agentId, '1.00'));
    // Nothing settled that first payment, and nothing ever will.
    expect(engine.reconcile({ graceMs: 0 }).unsettled).toBe(1);

    const { decision } = await engine.evaluateIntent(baseIntent(agentId, '0.50'));
    // The rolling budget is still charged for money that never moved. An agent
    // that never settles must not get an envelope that refills itself.
    expect(decision.outcome).toBe('deny');
  });
});

describe('a gap has an age, not a boolean', () => {
  it('reads as in-flight under the grace period and unsettled past it', async () => {
    const engine = await allowingEngine();
    await engine.evaluateIntent(baseIntent(newId('agt')));
    const at = Date.now();

    const fresh = engine.reconcile({ graceMs: 60_000, now: at + 1_000 });
    expect(fresh.inFlight).toBe(1);
    expect(fresh.unsettled).toBe(0);
    expect(fresh.gaps[0]?.state).toBe('in-flight');

    const aged = engine.reconcile({ graceMs: 60_000, now: at + 61_000 });
    expect(aged.inFlight).toBe(0);
    expect(aged.unsettled).toBe(1);
    expect(aged.gaps[0]?.state).toBe('unsettled');
    expect(aged.gaps[0]?.ageMs).toBeGreaterThanOrEqual(60_000);
  });

  it('counts the boundary itself as unsettled, so graceMs: 0 grants no grace', async () => {
    const engine = await allowingEngine();
    await engine.evaluateIntent(baseIntent(newId('agt')));

    // Read the recorded instant back rather than guessing it from Date.now():
    // the boundary has to be hit exactly or this pins nothing.
    const seen = engine.reconcile({ graceMs: 0, now: Date.now() + 1 }).gaps[0];
    const allowedAt = seen?.allowedAt ?? 0;
    expect(allowedAt).toBeGreaterThan(0);

    // Grace that has fully elapsed is spent, so the instant it runs out the
    // allowance is already a gap.
    const onTheDot = engine.reconcile({ graceMs: 60_000, now: allowedAt + 60_000 });
    expect(onTheDot.unsettled).toBe(1);
    expect(onTheDot.gaps[0]?.state).toBe('unsettled');
    expect(onTheDot.inFlight).toBe(0);

    // The CI race this came from: reconciling in the same millisecond the
    // allowance was written. Under a strict `>` this read as in-flight, which
    // made every `graceMs: 0` assertion in this file a coin flip on a fast
    // runner -- three jobs, three different failing subsets, same commit.
    const sameInstant = engine.reconcile({ graceMs: 0, now: allowedAt });
    expect(sameInstant.unsettled).toBe(1);
    expect(sameInstant.gaps[0]?.ageMs).toBe(0);
  });

  it('covers only the window, so an ancient allowance stops being news', async () => {
    const engine = await allowingEngine();
    await engine.evaluateIntent(baseIntent(newId('agt')));
    const tomorrow = Date.now() + 25 * 3_600_000;
    expect(engine.reconcile({ window: '24h', graceMs: 0, now: tomorrow }).allowed).toBe(0);
  });
});

describe('reporting posture', () => {
  it('carries settlementsSeen, so "no reporter" is distinguishable from "no settlements"', async () => {
    const engine = await allowingEngine();
    await engine.evaluateIntent(baseIntent(newId('agt')));
    // Zero reports: every allowance reads as a gap, and the count says why.
    expect(engine.reconcile({ graceMs: 0 })).toMatchObject({ unsettled: 1, settlementsSeen: 0 });

    await engine.recordSettlement({ intentId: newId('int'), confirmedAt: new Date() });
    // A settlement for some OTHER intent still proves a reporter is connected.
    expect(engine.reconcile({ graceMs: 0 })).toMatchObject({ unsettled: 1, settlementsSeen: 1 });
  });

  it('is idempotent per intent, the earliest confirmation winning', async () => {
    const engine = await allowingEngine();
    const { intent } = await engine.evaluateIntent(baseIntent(newId('agt')));
    const first = new Date(Date.now() - 10_000);
    await engine.recordSettlement({ intentId: intent.id, source: 'indexer', confirmedAt: first });
    await engine.recordSettlement({
      intentId: intent.id,
      source: 'guard',
      confirmedAt: new Date(),
    });
    expect(engine.settlements.count()).toBe(1);
    expect(engine.settlements.get(intent.id)?.source).toBe('indexer');
    expect(engine.settlements.get(intent.id)?.at).toBe(first.getTime());
  });

  it('keeps the earliest confirmation even when it is reported SECOND', async () => {
    // Arrival order is not the rule. The guard reports its local clock as it
    // pays; an indexer reports the chain's timestamp later -- and that one can
    // be the earlier of the two. The test above passes under either rule; this
    // one only passes under earliest-wins.
    const engine = await allowingEngine();
    const { intent } = await engine.evaluateIntent(baseIntent(newId('agt')));
    const chainTime = new Date(Date.now() - 10_000);
    await engine.recordSettlement({ intentId: intent.id, source: 'guard', confirmedAt: new Date() });
    await engine.recordSettlement({ intentId: intent.id, source: 'indexer', confirmedAt: chainTime });
    expect(engine.settlements.count()).toBe(1);
    expect(engine.settlements.get(intent.id)?.source).toBe('indexer');
    expect(engine.settlements.get(intent.id)?.at).toBe(chainTime.getTime());
  });

  it('does not let a settlement report change any decision', async () => {
    const engine = await allowingEngine();
    const { decision } = await engine.evaluateIntent(baseIntent(newId('agt')));
    await engine.recordSettlement({ intentId: decision.intentId, confirmedAt: new Date() });
    expect(engine.decisions()).toHaveLength(1);
    expect(engine.decisions()[0]).toEqual(decision);
  });
});

describe('allowances written before B1', () => {
  it('counts a record with no intent id as unattributed, never as a gap', () => {
    const spend = new InMemorySpendStore();
    const now = Date.now();
    // Exactly what a durable store hydrates from a pre-B1 data dir.
    spend.record({ agentId: 'agt_old', host: 'h', resource: '/r', amount: '9.99', at: now - 1_000 });
    const report = reconcile(spend, new InMemorySettlementStore(), { graceMs: 0, now });
    expect(report.unattributed).toBe(1);
    expect(report.allowed).toBe(0);
    expect(report.gaps).toEqual([]);
  });
});

describe('an approved escalation', () => {
  it('is one allowance for one intent, closed by one settlement', async () => {
    const approvals = new ApprovalService();
    const engine = new PolicyEngine({ approvals });
    await engine.addPolicy({
      policyId: 'pol_review',
      rules: [{ id: 'big-ticket', escalate: { amountGt: '10.00' } }],
      default: 'allow',
    });
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const approver = await approvals.registerApprover({
      orgId: newId('org'),
      name: 'Finance',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });

    const { intent, approval } = await engine.evaluateIntent(baseIntent(newId('agt'), '50.00'));
    // Parked, not allowed: nothing has been authorized, so nothing is expected
    // to settle and the escalation is not a gap.
    expect(engine.reconcile({ graceMs: 0 }).allowed).toBe(0);

    await engine.resolveEscalation(grant(approval as never, approver.id, privateKey, 'approve'));

    // The release appended a SECOND decision for the same intent. One payment,
    // one allowance — and the settlement for that intent closes it.
    const parked = engine.reconcile({ graceMs: 0 });
    expect(engine.decisions()).toHaveLength(2);
    expect(parked.allowed).toBe(1);
    expect(parked.gaps[0]?.intentId).toBe(intent.id);

    await engine.recordSettlement({ intentId: intent.id, confirmedAt: new Date() });
    expect(engine.reconcile({ graceMs: 0 }).unsettled).toBe(0);
  });
});

describe('the report itself', () => {
  it('caps its rows without lying about the counts, keeping the oldest gaps', async () => {
    const clock = { now: Date.now() - 5_000 };
    const engine = await allowingEngine(clock);
    const agentId = newId('agt');
    for (let i = 0; i < 5; i++) {
      await engine.evaluateIntent(baseIntent(agentId, '0.01'));
      clock.now += 1_000;
    }
    const report = engine.reconcile({ graceMs: 0, limit: 2 });
    expect(report.unsettled).toBe(5);
    expect(report.gaps).toHaveLength(2);
    expect(report.truncated).toBe(true);
    // Oldest first: the longest-standing gap is never the one dropped.
    expect(report.gaps[0]?.allowedAt).toBeLessThan(report.gaps[1]?.allowedAt ?? 0);
  });

  it('sorts unsettled before in-flight — the alarm is never below the fold', async () => {
    const clock = { now: Date.now() - 120_000 };
    const engine = await allowingEngine(clock);
    const agentId = newId('agt');
    await engine.evaluateIntent(baseIntent(agentId, '1.00'));
    clock.now = Date.now();
    await engine.evaluateIntent(baseIntent(agentId, '2.00'));
    const report = engine.reconcile({ graceMs: 60_000 });
    expect(report.gaps.map((g) => g.state)).toEqual(['unsettled', 'in-flight']);
  });

  it('narrows to one agent on request', async () => {
    const engine = await allowingEngine();
    const mine = newId('agt');
    await engine.evaluateIntent(baseIntent(mine, '1.00'));
    await engine.evaluateIntent(baseIntent(newId('agt'), '2.00'));
    const report = engine.reconcile({ graceMs: 0, agentId: mine });
    expect(report.allowed).toBe(1);
    expect(Number(report.unsettledValue)).toBeCloseTo(1);
  });
});

describe('the join read the other way: settled for more than was allowed', () => {
  async function settledFor(settledAmount: string | undefined, allowed = '1.00') {
    const engine = await allowingEngine();
    const { intent } = await engine.evaluateIntent(baseIntent(newId('agt'), allowed));
    await engine.recordSettlement({
      intentId: intent.id,
      source: 'indexer',
      confirmedAt: new Date(),
      ...(settledAmount !== undefined ? { amount: settledAmount } : {}),
    });
    return { engine, intent };
  }

  it('reports a settlement above the allowance as overspent, valued at the EXCESS', async () => {
    const { engine, intent } = await settledFor('1.25');
    const report = engine.reconcile({ graceMs: 0 });

    expect(report.overspent).toBe(1);
    expect(report.overspentValue).toBe('0.25');
    // Still settled -- the money moved -- and still summed at the amount
    // ALLOWED, so the excess is visible on its own line rather than folded in.
    expect(report.settled).toBe(1);
    expect(report.settledValue).toBe('1');
    expect(report.unsettled).toBe(0);
    expect(report.gaps).toHaveLength(1);
    expect(report.gaps[0]).toMatchObject({
      intentId: intent.id,
      state: 'overspent',
      amount: '1.00',
      settledAmount: '1.25',
    });
  });

  it('does not flag a settlement for exactly the allowed amount', async () => {
    const { engine } = await settledFor('1.00');
    const report = engine.reconcile({ graceMs: 0 });
    expect(report.overspent).toBe(0);
    expect(report.overspentValue).toBe('0');
    expect(report.gaps).toEqual([]);
  });

  it('does not flag a settlement under the ceiling, or one that reports no amount', async () => {
    // Less than allowed is inside the authority granted.
    expect((await settledFor('0.90')).engine.reconcile({ graceMs: 0 }).overspent).toBe(0);
    // The guard reports no amount on purpose: confirmation is not measurement,
    // and a missing number must never read as a breach.
    expect((await settledFor(undefined)).engine.reconcile({ graceMs: 0 }).overspent).toBe(0);
  });

  it('sorts overspent ahead of unsettled -- money that moved past the line outranks money in doubt', async () => {
    const engine = await allowingEngine();
    const agentId = newId('agt');
    // The gap is OLDER, so age alone would put it first.
    const gap = await engine.evaluateIntent(baseIntent(agentId, '2.00'));
    await new Promise((r) => setTimeout(r, 5));
    const over = await engine.evaluateIntent(baseIntent(agentId, '1.00'));
    await engine.recordSettlement({
      intentId: over.intent.id,
      amount: '3.00',
      confirmedAt: new Date(),
    });

    const report = engine.reconcile({ graceMs: 0 });
    expect(report.gaps.map((g) => g.state)).toEqual(['overspent', 'unsettled']);
    expect(report.gaps[0]?.intentId).toBe(over.intent.id);
    expect(report.gaps[1]?.intentId).toBe(gap.intent.id);
    expect(report.allowed).toBe(2);
    expect(report.overspentValue).toBe('2');
  });
});
