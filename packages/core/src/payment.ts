import { z } from 'zod';
import { IntentId } from './ids.js';
import { Chain } from './chain.js';
import { DecimalString } from './money.js';

/**
 * On-chain confirmation of a settled payment, reconciled by the indexer against
 * the originating intent (amount + recipient + nonce, or facilitator webhook).
 */
export const SettledPayment = z.object({
  intentId: IntentId,
  txHash: z.string(),
  chain: Chain,
  blockNumber: z.coerce.bigint(),
  facilitator: z.string().optional(),
  feePaid: DecimalString.optional(),
  confirmedAt: z.coerce.date(),
});
export type SettledPayment = z.infer<typeof SettledPayment>;

/**
 * A report that an allowed intent's payment actually landed — the settlement
 * half of reconciliation ("allowed but never settled", B1).
 *
 * Deliberately looser than {@link SettledPayment}: the on-chain confirmation
 * requires a tx hash and a block, while a REPORT is whatever the observer
 * could see. A vendor's `X-PAYMENT-RESPONSE` names a transaction but no block;
 * a facilitator webhook may name neither. Demanding the strong shape would
 * mean the weakest observers — the ones a deployment actually has — could
 * report nothing at all, and every allowance would read as a gap.
 *
 * `source` records WHO said so, because the evidence is not all equal: an
 * independent indexer watching the chain is the strong claim, while a guard
 * reporting on its own payment is the agent vouching for itself. Nothing here
 * grants authority — a settlement report can only ever CLOSE a gap in the
 * reconciliation report, never authorize a payment or alter a decision.
 */
export const SettlementReport = z.object({
  intentId: IntentId,
  /** The settling transaction, when the observer saw one. */
  txHash: z.string().optional(),
  chain: Chain.optional(),
  /** The amount as SETTLED, when known — may differ from the amount allowed. */
  amount: DecimalString.optional(),
  /** Free-form observer tag, e.g. "indexer", "guard", "facilitator". */
  source: z.string().min(1).max(64).optional(),
  confirmedAt: z.coerce.date(),
});
export type SettlementReport = z.infer<typeof SettlementReport>;
