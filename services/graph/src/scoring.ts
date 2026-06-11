import type { ReputationComponents } from '@rein/core';
import type { SubjectEvidence } from './evidence.js';

/**
 * Component weights, summing to 1. The blend is a deliberately transparent
 * heuristic: every component is 0–100 with higher = healthier, so a score is
 * readable straight off its explanation. Sophistication can replace this
 * later without touching the evidence model — scores are pure functions of
 * evidence, never stored.
 */
export interface ScoreWeights {
  volume: number;
  longevity: number;
  disputeRate: number;
  counterpartyQuality: number;
  settlementReliability: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  settlementReliability: 0.3,
  disputeRate: 0.3,
  volume: 0.15,
  counterpartyQuality: 0.15,
  longevity: 0.1,
};

const DAY_MS = 86_400_000;

/**
 * How much one bad observation hurts, relative to a plain refusal. Disputes
 * and shadow spends are deliberate misconduct; a replay means someone tried
 * to spend the same money twice; the rest is sloppiness.
 */
const BADNESS = { dispute: 4, shadowSpend: 4, replay: 3, refusal: 1, endorsementCredit: 2 };

const REPLAY_CODES = new Set(['payment_replayed', 'decision_replayed']);

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, value));
}

function refusalCounts(ev: SubjectEvidence): { replays: number; others: number } {
  let replays = 0;
  let others = 0;
  for (const [code, count] of Object.entries(ev.refusals)) {
    if (REPLAY_CODES.has(code)) replays += count;
    else others += count;
  }
  return { replays, others };
}

/** Saturating settled-transaction volume: 0 at none, ~63 at 20, ~92 at 50. */
export function volumeComponent(ev: SubjectEvidence): number {
  return 100 * (1 - Math.exp(-ev.settled / 20));
}

/** How long the subject has been known: linear to 100 at 30 days. */
export function longevityComponent(ev: SubjectEvidence, nowMs: number): number {
  const knownDays = Math.max(0, nowMs - ev.firstSeenMs) / DAY_MS;
  return 100 * Math.min(1, knownDays / 30);
}

/**
 * Dispute hygiene (the core field is named `disputeRate`; the component is
 * stored INVERTED — 100 = a clean record — so all five components blend in
 * the same direction). Weighted badness over total interactions; manual
 * endorsements buy back a little slack.
 */
export function disputeComponent(ev: SubjectEvidence): number {
  const { replays, others } = refusalCounts(ev);
  const badness = Math.max(
    0,
    ev.disputes * BADNESS.dispute +
      ev.shadowSpends * BADNESS.shadowSpend +
      replays * BADNESS.replay +
      others * BADNESS.refusal -
      ev.endorsements * BADNESS.endorsementCredit,
  );
  const interactions = Math.max(1, ev.attempts + ev.disputes + ev.endorsements);
  return 100 * Math.max(0, 1 - badness / interactions);
}

/** Settled / attempted. No attempts yet = neutral 50, not perfect 100. */
export function reliabilityComponent(ev: SubjectEvidence): number {
  if (ev.attempts === 0) return 50;
  return 100 * Math.min(1, ev.settled / ev.attempts);
}

/**
 * Confidence is first-class (see core ReputationScore): a thin or brand-new
 * history yields LOW confidence rather than a misleading score, so consumers
 * (engine sync, gate screening) can refuse to act on it. Depth of evidence
 * saturates around 10 observations; age discounts same-day evidence to 40%
 * and stops mattering after a week.
 */
export function confidence(ev: SubjectEvidence, nowMs: number): number {
  const { replays, others } = refusalCounts(ev);
  const observations =
    ev.attempts + ev.disputes + ev.endorsements + ev.shadowSpends + replays + others;
  const depth = 1 - Math.exp(-observations / 10);
  const knownDays = Math.max(0, nowMs - ev.firstSeenMs) / DAY_MS;
  const age = 0.4 + 0.6 * Math.min(1, knownDays / 7);
  return clamp(depth * age, 0, 1);
}

/** Blend all five components into the headline 0–100 score. */
export function blend(components: ReputationComponents, weights: ScoreWeights): number {
  const total =
    components.volume * weights.volume +
    components.longevity * weights.longevity +
    components.disputeRate * weights.disputeRate +
    components.counterpartyQuality * weights.counterpartyQuality +
    components.settlementReliability * weights.settlementReliability;
  return clamp(Math.round(total), 0, 100);
}

/**
 * The one-hop base score: the blend WITHOUT counterpartyQuality, with the
 * remaining weights renormalized. Counterparty quality for subject A averages
 * the base scores of A's counterparties — base, not full, so the computation
 * is a single hop and cycles (A pays B pays A) cannot recurse.
 */
export function blendBase(ev: SubjectEvidence, nowMs: number, weights: ScoreWeights): number {
  const remaining =
    weights.volume + weights.longevity + weights.disputeRate + weights.settlementReliability;
  if (remaining <= 0) return 50;
  const total =
    volumeComponent(ev) * weights.volume +
    longevityComponent(ev, nowMs) * weights.longevity +
    disputeComponent(ev) * weights.disputeRate +
    reliabilityComponent(ev) * weights.settlementReliability;
  return clamp(total / remaining, 0, 100);
}
