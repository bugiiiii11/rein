/**
 * @reinconsole/gate — the supply-side gate (Phase 2).
 *
 * Price your routes once and every x402 payment into your API is quoted,
 * cross-checked, screened, settled, and receipted before your handler runs:
 *
 *   const gate = createGate({ routes, rails, payTo, network, asset });
 *   app.use(gateMiddleware(gate));
 */

export {
  Gate,
  createGate,
  type GateOptions,
  type GateScreen,
  type GateRequest,
  type GateOutcome,
  type GateStats,
  type GateLineStats,
  bazaarExtension,
} from './gate.js';
export {
  matchRoute,
  requirementFor,
  routeDecimals,
  type GateRoute,
  type PaymentDefaults,
} from './routes.js';
export {
  mockFacilitatorRails,
  facilitatorClientRails,
  RailsUnreachableError,
  type GateRails,
  type GateSettlement,
  type MockFacilitatorLike,
  type FacilitatorClientLike,
} from './rails.js';
export { validateVelocity, type GateVelocity } from './velocity.js';
export {
  buildPaymentRequiredV2,
  caip2Of,
  encodeBase64Json,
  sameNetwork,
  v2Requirements,
  type PaymentRequiredV2,
  type PaymentRequirementsV2,
} from './v2.js';
export {
  InMemoryGateStore,
  type GateStorePort,
  type MaybePromise,
} from './stores.js';
export { gateMiddleware, type GateMiddlewareOptions } from './node.js';
export { createGatedFetch, type GatedFetchOptions } from './fetch.js';
export { inspectPaymentHeader, MAX_PAYMENT_HEADER_CHARS, type InspectedPayment } from './wire.js';
export { GateError, type GateRefusalCode } from './errors.js';

// Re-exported for convenience so gate users rarely need the other packages.
export type { GateReceipt, ReinEvent } from '@reinconsole/core';
export type { PaymentRequirement, PaymentRequired } from '@reinconsole/sdk';
