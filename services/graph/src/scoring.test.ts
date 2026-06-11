import { describe, it, expect } from 'vitest';
import type { SubjectEvidence } from './evidence.js';
import {
  DEFAULT_WEIGHTS,
  blend,
  blendBase,
  confidence,
  disputeComponent,
  longevityComponent,
  reliabilityComponent,
  volumeComponent,
} from './scoring.js';

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 5, 11, 12, 0, 0);

function evidence(over: Partial<SubjectEvidence> = {}): SubjectEvidence {
  return {
    subject: { kind: 'vendor', id: 'api.example.test' },
    firstSeenMs: NOW - 14 * DAY,
    lastSeenMs: NOW,
    attempts: 0,
    settled: 0,
    volume: '0',
    refusals: {},
    shadowSpends: 0,
    disputes: 0,
    endorsements: 0,
    counterparties: new Map(),
    ...over,
  };
}

describe('components (all 0–100, higher = healthier)', () => {
  it('volume saturates with settled count and starts at zero', () => {
    expect(volumeComponent(evidence())).toBe(0);
    const few = volumeComponent(evidence({ settled: 5 }));
    const many = volumeComponent(evidence({ settled: 50 }));
    expect(few).toBeGreaterThan(0);
    expect(many).toBeGreaterThan(few);
    expect(many).toBeLessThanOrEqual(100);
    expect(volumeComponent(evidence({ settled: 10_000 }))).toBeCloseTo(100, 1);
  });

  it('longevity is linear to 30 days then caps', () => {
    expect(longevityComponent(evidence({ firstSeenMs: NOW }), NOW)).toBe(0);
    expect(longevityComponent(evidence({ firstSeenMs: NOW - 15 * DAY }), NOW)).toBe(50);
    expect(longevityComponent(evidence({ firstSeenMs: NOW - 90 * DAY }), NOW)).toBe(100);
  });

  it('reliability is the settled/attempted ratio, neutral 50 with no attempts', () => {
    expect(reliabilityComponent(evidence())).toBe(50);
    expect(reliabilityComponent(evidence({ attempts: 4, settled: 4 }))).toBe(100);
    expect(reliabilityComponent(evidence({ attempts: 4, settled: 1 }))).toBe(25);
  });

  it('a clean record scores a perfect dispute component', () => {
    expect(disputeComponent(evidence({ attempts: 10, settled: 10 }))).toBe(100);
  });

  it('replays hurt more than plain refusals; disputes and shadow spends most', () => {
    const base = { attempts: 10, settled: 10 };
    const refused = disputeComponent(evidence({ ...base, refusals: { amount_mismatch: 1 } }));
    const replayed = disputeComponent(evidence({ ...base, refusals: { payment_replayed: 1 } }));
    const disputed = disputeComponent(evidence({ ...base, disputes: 1 }));
    const shadow = disputeComponent(evidence({ ...base, shadowSpends: 1 }));
    expect(refused).toBeLessThan(100);
    expect(replayed).toBeLessThan(refused);
    expect(disputed).toBeLessThan(replayed);
    // Same weight, but a shadow spend is not an interaction — it stings a
    // touch more than a dispute, which at least enlarges the denominator.
    expect(shadow).toBeLessThanOrEqual(disputed);
  });

  it('endorsements buy back slack but never push past clean', () => {
    const dinged = evidence({ attempts: 10, settled: 10, refusals: { amount_mismatch: 2 } });
    const vouched = evidence({
      attempts: 10,
      settled: 10,
      refusals: { amount_mismatch: 2 },
      endorsements: 1,
    });
    expect(disputeComponent(vouched)).toBeGreaterThan(disputeComponent(dinged));
    expect(disputeComponent(evidence({ attempts: 10, endorsements: 5 }))).toBe(100);
  });

  it('an all-bad record bottoms out at 0, never below', () => {
    expect(disputeComponent(evidence({ attempts: 3, refusals: { payment_replayed: 3 } }))).toBe(0);
  });
});

describe('confidence', () => {
  it('is low for a thin history and grows with observations', () => {
    const thin = confidence(evidence({ attempts: 1 }), NOW);
    const deep = confidence(evidence({ attempts: 40 }), NOW);
    expect(thin).toBeLessThan(0.2);
    expect(deep).toBeGreaterThan(0.9);
  });

  it('discounts same-day evidence even when heavy', () => {
    const fresh = confidence(evidence({ attempts: 40, firstSeenMs: NOW }), NOW);
    const aged = confidence(evidence({ attempts: 40, firstSeenMs: NOW - 7 * DAY }), NOW);
    expect(fresh).toBeLessThanOrEqual(0.41);
    expect(aged).toBeGreaterThan(0.9);
  });

  it('counts misconduct as observations — a busy rogue is confidently bad', () => {
    const rogue = confidence(
      evidence({ shadowSpends: 6, refusals: { payment_replayed: 6 } }),
      NOW,
    );
    expect(rogue).toBeGreaterThan(0.5);
  });

  it('zero evidence means zero confidence', () => {
    expect(confidence(evidence(), NOW)).toBe(0);
  });
});

describe('blend', () => {
  const perfect = {
    volume: 100,
    longevity: 100,
    disputeRate: 100,
    counterpartyQuality: 100,
    settlementReliability: 100,
  };

  it('is bounded, rounded, and weighted', () => {
    expect(blend(perfect, DEFAULT_WEIGHTS)).toBe(100);
    expect(blend({ ...perfect, volume: 0, longevity: 0 }, DEFAULT_WEIGHTS)).toBe(75);
    expect(
      blend(
        { volume: 0, longevity: 0, disputeRate: 0, counterpartyQuality: 0, settlementReliability: 0 },
        DEFAULT_WEIGHTS,
      ),
    ).toBe(0);
  });

  it('blendBase renormalizes the remaining weights (perfect stays perfect)', () => {
    const ev = evidence({
      attempts: 1000,
      settled: 1000,
      firstSeenMs: NOW - 90 * DAY,
    });
    expect(blendBase(ev, NOW, DEFAULT_WEIGHTS)).toBeCloseTo(100, 0);
  });

  it('is deterministic for the same evidence and clock', () => {
    const ev = evidence({ attempts: 7, settled: 5, disputes: 1 });
    expect(blendBase(ev, NOW, DEFAULT_WEIGHTS)).toBe(blendBase(ev, NOW, DEFAULT_WEIGHTS));
  });
});
