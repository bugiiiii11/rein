import { z } from 'zod';
import { GateReceiptId } from './ids.js';
import { DecimalString } from './money.js';

/**
 * The vendor-side twin of `Receipt`: one settled x402 payment as the GATE saw
 * it — who paid, for which priced route, and the settlement transaction. The
 * agent-side Receipt records what an agent tried to spend; a GateReceipt
 * records what a vendor actually earned.
 */
export const GateReceipt = z.object({
  id: GateReceiptId,
  at: z.coerce.date(),
  /** The route pattern that priced this request, e.g. "/api/reports/*". */
  route: z.string().min(1),
  /** The concrete resource paid for (URL path actually requested). */
  resource: z.string().min(1),
  method: z.string().min(1),
  /** The paying wallet address, as asserted by the settled payment. */
  payer: z.string().min(1),
  payTo: z.string().min(1),
  /** Human-unit decimal amount, e.g. "0.05". */
  amount: DecimalString,
  /** The same amount in the asset's atomic units, e.g. "50000". */
  amountAtomic: z.string().regex(/^\d+$/, 'atomic amount must be an integer string'),
  /** Token symbol or contract address, exactly as quoted in the requirement. */
  asset: z.string().min(1),
  network: z.string().min(1),
  /** Settlement transaction hash (mock ledger or on-chain). */
  transaction: z.string().min(1),
});
export type GateReceipt = z.infer<typeof GateReceipt>;
