import { z } from 'zod';
import { AgentId, DecisionId, IntentId, SessionId } from './ids.js';
import { Chain } from './chain.js';
import { DecimalString } from './money.js';
import { PaymentIntent } from './intent.js';
import { Decision } from './decision.js';
import { SettledPayment } from './payment.js';
import { GateReceipt } from './gate-receipt.js';

/**
 * The canonical event envelope published on the bus (NATS in production).
 * `shadow.spend` is emitted when the indexer sees on-chain spend from a managed
 * wallet with NO corresponding ALLOW decision — the bypass signal that catches
 * SDK-mode evasion and drives the upgrade to the signer tier.
 * `signature.released` / `signature.refused` are that tier's heartbeat: every
 * time the signer does or does not put a key to work, the bus knows why.
 * `gate.*` is the vendor side of the wire: every quote a Gate issues, every
 * payment it accepts, every payment it turns away.
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
  z.object({
    type: z.literal('signature.released'),
    at: z.coerce.date(),
    sessionId: SessionId,
    agentId: AgentId,
    intentId: IntentId,
    decisionId: DecisionId,
    amount: DecimalString,
  }),
  z.object({
    type: z.literal('signature.refused'),
    at: z.coerce.date(),
    /** Refusal code, e.g. "decision_replayed" (see @reinconsole/signer). */
    code: z.string(),
    reason: z.string(),
    sessionId: SessionId.optional(),
    agentId: AgentId.optional(),
    intentId: IntentId.optional(),
  }),
  z.object({
    type: z.literal('gate.quoted'),
    at: z.coerce.date(),
    resource: z.string(),
    method: z.string(),
    amount: DecimalString,
    asset: z.string(),
    network: z.string(),
  }),
  z.object({ type: z.literal('gate.settled'), at: z.coerce.date(), receipt: GateReceipt }),
  z.object({
    type: z.literal('gate.refused'),
    at: z.coerce.date(),
    /** Refusal code, e.g. "payment_replayed" (see @reinconsole/gate). */
    code: z.string(),
    reason: z.string(),
    resource: z.string(),
    /** Known only when the payment header decoded far enough to name a payer. */
    payer: z.string().optional(),
  }),
]);
export type ReinEvent = z.infer<typeof ReinEvent>;
