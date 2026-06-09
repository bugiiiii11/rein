import { z } from 'zod';
import { AgentId } from './ids.js';
import { Chain } from './chain.js';
import { DecimalString } from './money.js';
import { PaymentIntent } from './intent.js';
import { Decision } from './decision.js';
import { SettledPayment } from './payment.js';

/**
 * The canonical event envelope published on the bus (NATS in production).
 * `shadow.spend` is emitted when the indexer sees on-chain spend from a managed
 * wallet with NO corresponding ALLOW decision — the bypass signal that catches
 * SDK-mode evasion and drives the upgrade to the signer tier.
 */
export const ReinEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('intent.created'), at: z.coerce.date(), intent: PaymentIntent }),
  z.object({ type: z.literal('decision.made'), at: z.coerce.date(), decision: Decision }),
  z.object({ type: z.literal('payment.settled'), at: z.coerce.date(), payment: SettledPayment }),
  z.object({
    type: z.literal('shadow.spend'),
    at: z.coerce.date(),
    agentId: AgentId,
    txHash: z.string(),
    chain: Chain,
    amount: DecimalString,
  }),
]);
export type ReinEvent = z.infer<typeof ReinEvent>;
