/**
 * @reinconsole/sdk — the demand-side guard.
 *
 * Wrap your agent's fetch once and every x402 payment is policy-checked,
 * receipted, and observable before a cent moves:
 *
 *   const guard = createGuard({ engineUrl, agentId });
 *   const fetch = guard.wrap();
 */

export { Guard, createGuard, type GuardOptions, type Payer } from './guard.js';
export {
  EngineClient,
  type EngineClientOptions,
  type EvaluateResponse,
  type FetchLike,
} from './client.js';
export {
  PaymentRequired,
  PaymentRequirement,
  selectRequirement,
  resolveAsset,
  networkToChain,
  atomicToDecimal,
  decimalToAtomic,
  requirementDecimals,
  toIntentSubmission,
  type ResolvedRequirement,
  type IntentSubmission,
} from './x402.js';
export {
  ReinError,
  EngineError,
  PaymentBlockedError,
  UnsupportedRequirementError,
} from './errors.js';

// Re-exported for convenience so SDK users rarely need @reinconsole/core directly.
export type { Receipt, ReceiptSettlement, Decision, PaymentIntent, TaskContext } from '@reinconsole/core';
