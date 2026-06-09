/**
 * @rein/mock-rails — the simulated payment world for v0.1.
 *
 * Three pieces, mirroring the production architecture:
 * - MockLedger      — the chain: append-only transfers, open to anyone.
 * - MockFacilitator — x402 settlement (Coinbase's role); plugs into the SDK
 *                     guard via `payerFor()`.
 * - MockIndexer     — watches the ledger, reconciles managed-wallet spend
 *                     against ALLOW decisions, and emits `payment.settled`
 *                     or `shadow.spend` (the bypass signal).
 *
 * Plus `createMockVendor()`, an in-process paywalled vendor that completes
 * the loop for tests and demos.
 */

export { MockLedger, type LedgerEntry, type TransferInput } from './ledger.js';
export {
  MockFacilitator,
  type MockFacilitatorOptions,
  type SettleResult,
} from './facilitator.js';
export {
  MockIndexer,
  type MockIndexerOptions,
  type EngineEvents,
  type ShadowSpend,
} from './indexer.js';
export { createMockVendor, type MockVendor, type MockVendorOptions, type VendorCall } from './vendor.js';
export {
  MockExactPayload,
  MockPaymentHeader,
  SettlementResponse,
  encodePaymentHeader,
  decodePaymentHeader,
  encodeSettlementHeader,
} from './payload.js';
export { FacilitatorError, type FacilitatorErrorCode } from './errors.js';
