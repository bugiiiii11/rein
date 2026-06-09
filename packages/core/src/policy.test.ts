import { describe, it, expect } from 'vitest';
import { Policy, Rule, Condition } from './policy.js';

describe('Policy schema', () => {
  // The exact example policy from the technical documentation (§3.3).
  const docPolicy = {
    policyId: 'pol_treasury_v3',
    appliesTo: { agents: ['agt_research_*'], chains: ['base', 'solana'] },
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
    denyFloor: '0.05',
    escalation: { approvers: ['ops-channel'], timeoutAction: 'deny', timeoutMin: 15 },
  };

  it('parses the documented treasury policy verbatim', () => {
    const parsed = Policy.parse(docPolicy);
    expect(parsed.policyId).toBe('pol_treasury_v3');
    expect(parsed.rules).toHaveLength(7);
    expect(parsed.version).toBe('1'); // default applied
  });

  it('applies sensible defaults for a minimal policy', () => {
    const parsed = Policy.parse({ policyId: 'pol_min' });
    expect(parsed.default).toBe('deny');
    expect(parsed.denyFloor).toBe('0.05');
    expect(parsed.rules).toEqual([]);
  });
});

describe('Rule schema', () => {
  it('requires exactly one action', () => {
    expect(Rule.safeParse({ id: 'r', deny: { amountGt: '1' } }).success).toBe(true);
    // zero actions -> invalid
    expect(Rule.safeParse({ id: 'r' }).success).toBe(false);
    // two actions -> invalid
    expect(
      Rule.safeParse({ id: 'r', deny: { amountGt: '1' }, allow: { amountGt: '2' } }).success,
    ).toBe(false);
  });
});

describe('Condition schema', () => {
  it('rejects an empty condition', () => {
    expect(Condition.safeParse({}).success).toBe(false);
  });

  it('validates window and multiplier formats', () => {
    expect(Condition.safeParse({ rollingSum: { window: '24h', gt: '5' } }).success).toBe(true);
    expect(Condition.safeParse({ rollingSum: { window: '24', gt: '5' } }).success).toBe(false);
    expect(Condition.safeParse({ amountVsResourceMedian: { gt: '3x' } }).success).toBe(true);
    expect(Condition.safeParse({ amountVsResourceMedian: { gt: '3' } }).success).toBe(false);
  });
});
