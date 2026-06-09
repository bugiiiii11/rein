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
