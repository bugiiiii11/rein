import type { PaymentRequirement } from '@rein/sdk';
import { GateError } from './errors.js';
import { encodeSettlementHeader, inspectPaymentHeader } from './wire.js';

/**
 * The gate's settlement seam. The gate decides WHETHER a payment is acceptable
 * (routes, screening, replay, amount cross-checks); the rails decide whether it
 * is VALID and move the money. Both Rein rails plug in via the structural
 * adapters below — @rein/gate deliberately imports neither, so vendors install
 * only what they run.
 */
export interface GateRails {
  /** Throw GateError('verify_failed') if the payment does not check out. */
  verify(paymentHeader: string, requirement: PaymentRequirement): Promise<void>;
  /** Move the money. Throw GateError('settle_failed') if it cannot. */
  settle(paymentHeader: string, requirement: PaymentRequirement): Promise<GateSettlement>;
}

export interface GateSettlement {
  /** Ready-made X-PAYMENT-RESPONSE header value. */
  header: string;
  /** Settlement transaction hash (mock ledger or on-chain). */
  transaction: string;
  network: string;
  payer?: string;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** What the gate needs of @rein/mock-rails' MockFacilitator (structural). */
export interface MockFacilitatorLike {
  verify(paymentHeader: string, requirement: PaymentRequirement): unknown;
  settle(
    paymentHeader: string,
    requirement: PaymentRequirement,
  ): { header: string; response: { transaction: string; network: string; payer?: string } };
}

/** Wire the gate to the mock rails (offline twin; throws map to refusals). */
export function mockFacilitatorRails(facilitator: MockFacilitatorLike): GateRails {
  return {
    async verify(paymentHeader, requirement) {
      try {
        facilitator.verify(paymentHeader, requirement);
      } catch (err) {
        throw new GateError('verify_failed', messageOf(err));
      }
    },
    async settle(paymentHeader, requirement) {
      let settled;
      try {
        settled = facilitator.settle(paymentHeader, requirement);
      } catch (err) {
        throw new GateError('settle_failed', messageOf(err));
      }
      return {
        header: settled.header,
        transaction: settled.response.transaction,
        network: settled.response.network,
        payer: settled.response.payer,
      };
    },
  };
}

/** What the gate needs of @rein/x402-rails' FacilitatorClient (structural). */
export interface FacilitatorClientLike {
  verify(
    payload: unknown,
    requirements: PaymentRequirement,
  ): Promise<{ isValid: boolean; invalidReason?: string }>;
  settle(
    payload: unknown,
    requirements: PaymentRequirement,
  ): Promise<{
    success: boolean;
    errorReason?: string;
    transaction: string;
    network: string;
    payer?: string;
  }>;
}

/**
 * Wire the gate to a real x402 facilitator client. The v1 facilitator wants the
 * DECODED payment envelope; the gate re-decodes the header it already
 * inspected and relays the facilitator's settle response verbatim into
 * X-PAYMENT-RESPONSE (tx hash included).
 */
export function facilitatorClientRails(client: FacilitatorClientLike): GateRails {
  return {
    async verify(paymentHeader, requirement) {
      const { envelope } = inspectPaymentHeader(paymentHeader);
      const verified = await client.verify(envelope, requirement);
      if (!verified.isValid) {
        throw new GateError('verify_failed', verified.invalidReason ?? 'payment verification failed');
      }
    },
    async settle(paymentHeader, requirement) {
      const { envelope } = inspectPaymentHeader(paymentHeader);
      const settled = await client.settle(envelope, requirement);
      if (!settled.success) {
        throw new GateError('settle_failed', settled.errorReason ?? 'payment settlement failed');
      }
      return {
        header: encodeSettlementHeader(settled),
        transaction: settled.transaction,
        network: settled.network,
        payer: settled.payer,
      };
    },
  };
}
