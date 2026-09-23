/**
 * @reinconsole/x402-rails — the real payment world, on Base Sepolia.
 *
 * The live siblings of @reinconsole/mock-rails: an EIP-3009 payer that signs real
 * x402 v1 payments (plugs into the SDK guard), an HTTP client for the hosted
 * facilitator at x402.org (verify/settle — the facilitator submits the tx and
 * pays gas), an in-process vendor wired to it, and an on-chain indexer that
 * reconciles managed-wallet USDC transfers into payment.settled /
 * shadow.spend via the intent-derived authorization nonce.
 */

export {
  ExactEvmAuthorization,
  ExactEvmPayload,
  PaymentPayload,
  PaymentPayloadV2,
  VerifyResponse,
  SettleResponse,
  encodePaymentHeader,
  decodePaymentHeader,
  decodeAnyPaymentHeader,
  encodeSettlementHeader,
  type DecodedPayment,
} from './wire.js';
export { intentNonce } from './nonce.js';
export { chainIdForNetwork } from './networks.js';
export {
  TESTNET,
  MAINNET,
  PROFILES,
  BASE_USDC,
  BASE_SEPOLIA_USDC_ADDRESS,
  TESTNET_FACILITATOR_URL,
  CDP_FACILITATOR_URL,
  parseProfileName,
  profileFor,
  profileForNetwork,
  type NetworkProfile,
  type ProfileName,
} from './profiles.js';
export {
  createProfileFacilitator,
  cdpAuthHeaders,
  type CdpCredentials,
  type ProfileFacilitatorOptions,
} from './cdp.js';
export {
  createX402Payer,
  transferWithAuthorizationTypes,
  type X402PayerOptions,
  type PayerAccount,
} from './payer.js';
export {
  FacilitatorClient,
  DEFAULT_FACILITATOR_URL,
  type FacilitatorClientOptions,
} from './facilitator.js';
export { createRealVendor, type RealVendor, type RealVendorOptions, type VendorCall } from './vendor.js';
export {
  OnchainIndexer,
  railEventsAbi,
  type OnchainIndexerOptions,
  type EngineEvents,
  type AllowedIntent,
  type ChainReader,
  type RailLog,
  type ShadowSpend,
} from './indexer.js';
export {
  BASE_SEPOLIA_USDC,
  CIRCLE_FAUCET_URL,
  basescanTxUrl,
  generateWallet,
  addressForPrivateKey,
  createBaseSepoliaClient,
  createChainClient,
  getUsdcBalance,
  getProfileUsdcBalance,
  type BaseSepoliaClient,
  type GeneratedWallet,
} from './wallet.js';
export { RailsError, FacilitatorHttpError, type RailsErrorCode } from './errors.js';
