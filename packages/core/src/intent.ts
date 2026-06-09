import { z } from 'zod';
import { AgentId, IntentId } from './ids.js';
import { Chain, Asset } from './chain.js';
import { DecimalString } from './money.js';

export const Vendor = z.object({
  host: z.string().min(1),
  address: z.string().min(1),
  erc8004Id: z.string().optional(),
});
export type Vendor = z.infer<typeof Vendor>;

/**
 * The observability gold: links every micro-payment back to the task and run
 * that caused it, so finance teams can answer "what was this spend for?".
 */
export const TaskContext = z.object({
  taskId: z.string().optional(),
  parentRunId: z.string().optional(),
  purpose: z.string().max(500).optional(),
});
export type TaskContext = z.infer<typeof TaskContext>;

/**
 * A request to spend, submitted to the policy engine BEFORE any signature is
 * released. The `nonce` provides replay protection on the signer path.
 */
export const PaymentIntent = z.object({
  id: IntentId,
  agentId: AgentId,
  vendor: Vendor,
  resource: z.string(),
  amount: DecimalString,
  asset: Asset,
  chain: Chain,
  taskContext: TaskContext.default({}),
  nonce: z.string().min(1),
  createdAt: z.coerce.date(),
});
export type PaymentIntent = z.infer<typeof PaymentIntent>;
