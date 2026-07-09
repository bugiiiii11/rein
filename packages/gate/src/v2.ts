/**
 * x402 v2 wire builders (vendor side). The canonical implementations moved to
 * @reinconsole/sdk (x402v2.ts) when the payer side learned v2 — one dialect
 * codec serves both sides of the wire. Re-exported here so the gate's public
 * surface and internal imports stay put.
 */
export {
  buildPaymentRequiredV2,
  caip2Of,
  encodeBase64Json,
  sameNetwork,
  v2Requirements,
  type PaymentRequiredV2,
  type PaymentRequirementsV2,
} from '@reinconsole/sdk';
