import { z } from 'zod';
import { ReceiptId, IntentId, DecisionId, AgentId } from './ids.js';
import { Chain, Asset } from './chain.js';
import { DecimalString } from './money.js';
import { TaskContext } from './intent.js';
import { DecisionOutcome } from './decision.js';

/**
 * What the SDK reports back after settlement: the `X-PAYMENT-RESPONSE` header
 * a vendor returns once payment clears. Mock facilitators fill this in v0.1;
 * the indexer reconciles it against on-chain truth later (see SettledPayment).
 */
export const ReceiptSettlement = z.object({
  txHash: z.string().optional(),
  networkId: z.string().optional(),
  /** Raw header payload, kept for forensics until the indexer confirms. */
  raw: z.string().optional(),
});
export type ReceiptSettlement = z.infer<typeof ReceiptSettlement>;

/**
 * The SDK-side record of one guarded payment attempt: which request triggered
 * it, what the engine decided, and (if allowed and paid) how it settled.
 * Receipts are the observability primitive — every 402 the guard touches
 * produces exactly one, whether the payment was allowed or blocked.
 */
export const Receipt = z.object({
  id: ReceiptId,
  agentId: AgentId,
  intentId: IntentId,
  decisionId: DecisionId,
  outcome: DecisionOutcome,
  /** The URL the agent actually fetched (the paywalled resource). */
  url: z.string(),
  method: z.string().default('GET'),
  vendorHost: z.string(),
  amount: DecimalString,
  asset: Asset,
  chain: Chain,
  taskContext: TaskContext.default({}),
  /** Human-readable explanation copied from the decision. */
  reason: z.string().optional(),
  /** Present only once a payment was made and the vendor confirmed it. */
  settlement: ReceiptSettlement.optional(),
  createdAt: z.coerce.date(),
});
export type Receipt = z.infer<typeof Receipt>;
