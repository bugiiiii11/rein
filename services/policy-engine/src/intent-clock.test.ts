import { describe, it, expect } from 'vitest';
import { newId } from '@reinconsole/core';
import { PolicyEngine } from './engine.js';

/**
 * The evaluation clock is the engine's, never the caller's.
 *
 * `IntentInput.createdAt` is an optional, unbounded field on the `/v1/evaluate`
 * body, and it used to be the "now" every time-based predicate was measured
 * against. `within()` filters on a lower bound only, so an intent dated past
 * the end of a window saw an EMPTY history: rolling budgets, velocity counts
 * and circuit breakers all read zero. The allow that followed was a properly
 * signed decision, so the signer honoured it and the money moved -- and the
 * allowance row, stamped at the same future instant, fell outside the window
 * reconciliation reads, so the overspend was invisible to the report as well.
 *
 * One field in a request body, and every control the product is named for.
 */
describe('the evaluation clock is not the caller’s to set', () => {
  const intent = (agentId: string, amount: string, createdAt?: Date) => ({
    agentId,
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount,
    asset: 'USDC' as const,
    chain: 'base' as const,
    ...(createdAt ? { createdAt } : {}),
  });

  async function budgetEngine() {
    const engine = new PolicyEngine();
    await engine.addPolicy({
      policyId: 'pol_budget',
      rules: [{ id: 'day-budget', deny: { rollingSum: { window: '24h', gt: '10.00' } } }],
      default: 'allow',
    });
    return engine;
  }

  it('a future-dated intent cannot walk a rolling budget out of its own window', async () => {
    const engine = await budgetEngine();
    const agentId = newId('agt');
    const day = 86_400_000;

    const first = await engine.evaluateIntent(intent(agentId, '9.00'));
    expect(first.decision.outcome).toBe('allow');

    // Each subsequent intent claims to happen a window further out. Before the
    // fix every one of these was allowed: 45.00 against a 10.00/24h budget.
    for (let i = 2; i <= 5; i += 1) {
      const next = await engine.evaluateIntent(
        intent(agentId, '9.00', new Date(Date.now() + i * 2 * day)),
      );
      expect(next.decision.outcome, `intent ${i} dated ${i * 2} days out`).toBe('deny');
      expect(next.decision.matchedRules).toContain('day-budget');
    }
  });

  it('a future-dated allowance still lands inside the window reconciliation reads', async () => {
    const engine = await budgetEngine();
    const agentId = newId('agt');
    await engine.evaluateIntent(intent(agentId, '1.00', new Date(Date.now() + 30 * 86_400_000)));

    // The ledger row is stamped from the engine's clock, so the spend it
    // represents is visible to the operator who has to answer for it.
    const report = engine.reconcile({ window: '24h', graceMs: 0 });
    expect(report.allowed).toBe(1);
    expect(report.unsettled).toBe(1);
  });

  it('a future-dated intent cannot silence the dead-man monitor', async () => {
    const engine = await budgetEngine();
    const agentId = newId('agt');
    const far = Date.now() + 365 * 86_400_000;
    await engine.evaluateIntent(intent(agentId, '1.00', new Date(far)));

    // No liveness monitor is configured here, so the assertion is on the
    // recorded instant itself: a sighting stamped a year out would keep a dead
    // agent looking alive for a year.
    const gap = engine.reconcile({ graceMs: 0 }).gaps[0];
    expect(gap?.allowedAt).toBeLessThan(far);
  });

  it('still reports the time the caller claimed', async () => {
    const engine = await budgetEngine();
    const claimed = new Date(Date.now() + 7 * 86_400_000);
    const { intent: normalized } = await engine.evaluateIntent(
      intent(newId('agt'), '1.00', claimed),
    );
    // `createdAt` is not ignored, it is demoted: still on the intent, still
    // committed to by the hash, just no longer deciding anything.
    expect(normalized.createdAt.getTime()).toBe(claimed.getTime());
  });
});
