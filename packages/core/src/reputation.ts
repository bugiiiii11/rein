import { z } from 'zod';

export const ReputationSubject = z.object({
  kind: z.enum(['agent', 'vendor']),
  id: z.string(),
});
export type ReputationSubject = z.infer<typeof ReputationSubject>;

export const ReputationComponents = z.object({
  volume: z.number(),
  longevity: z.number(),
  disputeRate: z.number(),
  counterpartyQuality: z.number(),
  settlementReliability: z.number(),
});
export type ReputationComponents = z.infer<typeof ReputationComponents>;

/**
 * A reputation score for an agent or vendor (Phase 3 — Graph). `confidence` is
 * first-class: a thin-history subject returns LOW confidence rather than a
 * misleadingly high score, so policy can avoid both false trust and unfair
 * freezing.
 */
export const ReputationScore = z.object({
  subject: ReputationSubject,
  score: z.number().min(0).max(100),
  components: ReputationComponents,
  confidence: z.number().min(0).max(1),
  asOf: z.coerce.date(),
  /** Hash-anchored attestation, optionally published on-chain (ERC-8004). */
  evidenceUri: z.string().optional(),
});
export type ReputationScore = z.infer<typeof ReputationScore>;
