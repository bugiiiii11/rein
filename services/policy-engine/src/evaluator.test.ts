import { describe, it, expect } from 'vitest';
import { Policy, PaymentIntent, newId } from '@rein/core';
import { evaluate, policyApplies, type SpendContext } from './evaluator.js';

/** The documented treasury policy (technical doc §3.3). */
const treasuryPolicy = Policy.parse({
  policyId: 'pol_treasury_v3',
  rules: [
    { id: 'hard-cap-tx', deny: { amountGt: '5.00' } },
    { id: 'daily-budget', deny: { rollingSum: { window: '24h', gt: '50.00' } } },
    { id: 'hourly-velocity', escalate: { txCount: { window: '1h', gt: 120 } } },
    { id: 'vendor-allow', allow: { vendorHostIn: ['api.example.com', '*.trusted.io'] } },
    { id: 'novel-vendor', escalate: { vendorFirstSeen: true, amountGt: '0.50' } },
    { id: 'reputation-gate', deny: { vendorReputationLt: 40 } },
    { id: 'price-sanity', escalate: { amountVsResourceMedian: { gt: '3x' } } },
  ],
  default: 'deny',
});

function ctx(overrides: Partial<SpendContext> = {}): SpendContext {
  return {
    rollingSum: () => '0',
    txCount: () => 0,
    isVendorFirstSeen: () => false,
    vendorReputation: () => undefined,
    resourceMedian: () => undefined,
    ...overrides,
  };
}

function intent(partial: Partial<Record<string, unknown>> = {}): PaymentIntent {
  return PaymentIntent.parse({
    id: newId('int'),
    agentId: newId('agt'),
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount: '0.01',
    asset: 'USDC',
    chain: 'base',
    nonce: 'n',
    createdAt: new Date(),
    ...partial,
  });
}

describe('evaluate — documented rule types', () => {
  it('ALLOWs an in-policy payment to an allowlisted vendor', () => {
    const r = evaluate(intent({ amount: '0.01' }), [treasuryPolicy], ctx());
    expect(r.outcome).toBe('allow');
    expect(r.matchedRules).toContain('vendor-allow');
  });

  it('DENYs above the per-tx hard cap', () => {
    const r = evaluate(intent({ amount: '6.00' }), [treasuryPolicy], ctx());
    expect(r.outcome).toBe('deny');
    expect(r.matchedRules).toContain('hard-cap-tx');
  });

  it('DENYs when the rolling daily budget would be exceeded', () => {
    const r = evaluate(
      intent({ amount: '0.01' }),
      [treasuryPolicy],
      ctx({ rollingSum: () => '49.995' }),
    );
    expect(r.outcome).toBe('deny');
    expect(r.matchedRules).toContain('daily-budget');
  });

  it('ESCALATEs on hourly velocity spikes', () => {
    const r = evaluate(intent({ amount: '0.01' }), [treasuryPolicy], ctx({ txCount: () => 120 }));
    expect(r.outcome).toBe('escalate');
    expect(r.matchedRules).toContain('hourly-velocity');
  });

  it('ESCALATEs a novel vendor above the dust threshold', () => {
    const r = evaluate(
      intent({ amount: '0.75', vendor: { host: 'api.new.com', address: '0x9' } }),
      [treasuryPolicy],
      ctx({ isVendorFirstSeen: () => true }),
    );
    expect(r.outcome).toBe('escalate');
    expect(r.matchedRules).toContain('novel-vendor');
  });

  it('DENYs a low-reputation vendor (Phase 3 hook)', () => {
    const r = evaluate(
      intent({ vendor: { host: 'api.sketchy.com', address: '0x9' } }),
      [treasuryPolicy],
      ctx({ vendorReputation: () => 30 }),
    );
    expect(r.outcome).toBe('deny');
    expect(r.matchedRules).toContain('reputation-gate');
  });

  it('ESCALATEs when price is far above the resource median', () => {
    const r = evaluate(
      intent({ amount: '0.04', vendor: { host: 'api.new.com', address: '0x9' } }),
      [treasuryPolicy],
      ctx({ resourceMedian: () => '0.01' }),
    );
    expect(r.outcome).toBe('escalate');
    expect(r.matchedRules).toContain('price-sanity');
  });
});

describe('evaluate — precedence and defaults', () => {
  it('DENY beats a matching ALLOW (deny > escalate > allow)', () => {
    // Over hard cap AND on the allowlist: deny must win.
    const r = evaluate(intent({ amount: '9.99' }), [treasuryPolicy], ctx());
    expect(r.outcome).toBe('deny');
  });

  it('falls through to the policy default when no rule matches', () => {
    const open = Policy.parse({ policyId: 'pol_open', rules: [], default: 'allow' });
    expect(evaluate(intent(), [open], ctx()).outcome).toBe('allow');
    const closed = Policy.parse({ policyId: 'pol_closed', rules: [], default: 'deny' });
    expect(evaluate(intent(), [closed], ctx()).outcome).toBe('deny');
  });

  it('fails closed (deny) when no policy applies', () => {
    const r = evaluate(intent(), [], ctx());
    expect(r.outcome).toBe('deny');
    expect(r.policyId).toBe('none');
  });

  it('does not trigger reputation-gate when reputation is unknown', () => {
    const r = evaluate(
      intent({ vendor: { host: 'api.example.com', address: '0x1' } }),
      [treasuryPolicy],
      ctx({ vendorReputation: () => undefined }),
    );
    expect(r.outcome).toBe('allow'); // allowlisted, no deny triggered
  });
});

describe('policyApplies', () => {
  it('filters by chain', () => {
    const p = Policy.parse({ policyId: 'p', appliesTo: { chains: ['solana'] } });
    expect(policyApplies(p, intent({ chain: 'base' }))).toBe(false);
    expect(policyApplies(p, intent({ chain: 'solana' }))).toBe(true);
  });

  it('filters by agent-id glob', () => {
    // Agent ids are opaque ULIDs, so glob targeting works for "all agents"
    // (agt_*) or exact ids. Semantic grouping like the doc's "agt_research_*"
    // needs agent labels (tracked as a future item), not id globs.
    const a = newId('agt');
    const matchAll = Policy.parse({ policyId: 'p_all', appliesTo: { agents: ['agt_*'] } });
    const matchNone = Policy.parse({ policyId: 'p_none', appliesTo: { agents: ['other_*'] } });
    expect(policyApplies(matchAll, intent({ agentId: a }))).toBe(true);
    expect(policyApplies(matchNone, intent({ agentId: a }))).toBe(false);
  });
});
