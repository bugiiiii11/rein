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

/**
 * Reduce an intent's `resource` to its path for policy matching. The value is
 * vendor-declared and shape-varies: the x402 spec puts a full URL in
 * `requirement.resource`, while the guard falls back to the request pathname
 * when the vendor omits it. Policies match on the PATH so authors never need
 * to know which shape a vendor emits; host targeting stays with
 * `vendorHostIn`, which is derived from the real request URL rather than the
 * vendor's own claim. Query strings do not survive the reduction.
 */
export function resourcePathOf(resource: string): string {
  try {
    const url = new URL(resource);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.pathname;
  } catch {
    // Not a URL — already a bare path.
  }
  return resource;
}
