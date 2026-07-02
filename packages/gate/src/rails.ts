import type { PaymentRequirement } from '@rein/sdk';
import { GateError } from './errors.js';
import { v2Requirements } from './v2.js';
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

/**
 * Error taxonomy at this seam — the gate's retry policy hangs off it:
 *
 * - `GateError` — a semantic verdict (bad signature, rejected authorization).
 *   Final; never retried.
 * - `RailsUnreachableError` — the request PROVABLY never reached the rails
 *   (connection refused, DNS failure). Safe to retry, even for settle.
 * - anything else — ambiguous transport failure (timeout, connection reset,
 *   gateway error): the request MAY have executed. verify is read-only so the
 *   gate retries it anyway; an ambiguous settle failure is never retried and
 *   refuses `settle_unknown`, because re-settling an authorization that
 *   actually landed would misreport a paid payment as failed.
 */
export class RailsUnreachableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'RailsUnreachableError';
  }
}

/** Error codes proving the request never left this machine. */
const NEVER_SENT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** Walk cause chains (and AggregateError fan-outs) for a never-sent code. */
function isNeverSent(err: unknown): boolean {
  for (let e = err; e !== null && e !== undefined; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && NEVER_SENT_CODES.has(code)) return true;
    if (e instanceof AggregateError && e.errors.some(isNeverSent)) return true;
  }
  return false;
}

/** Re-throw a transport error, tagged when it provably never reached the rails. */
function classifyTransport(err: unknown): never {
  if (isNeverSent(err)) {
    throw new RailsUnreachableError(messageOf(err), { cause: err });
  }
  throw err;
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

/** What the gate needs of @rein/x402-rails' FacilitatorClient (structural).
 *  `requirements` is untyped because the DIALECT varies per payment: v1
 *  payments relay Rein's internal (v1-shaped) requirement, v2 payments the
 *  converted v2 shape (see facilitatorClientRails). */
export interface FacilitatorClientLike {
  verify(
    payload: unknown,
    requirements: unknown,
  ): Promise<{ isValid: boolean; invalidReason?: string }>;
  settle(
    payload: unknown,
    requirements: unknown,
  ): Promise<{
    success: boolean;
    errorReason?: string;
    transaction: string;
    network: string;
    payer?: string;
  }>;
}

/**
 * Wire the gate to a real x402 facilitator client. The facilitator wants the
 * DECODED payment envelope; the gate re-decodes the header it already
 * inspected and relays the facilitator's settle response verbatim into the
 * settlement header (tx hash included). Requirements travel in the same
 * dialect the payment arrived in — a v2 envelope is verified against
 * v2-shaped (amount/CAIP-2) requirements.
 */
export function facilitatorClientRails(client: FacilitatorClientLike): GateRails {
  const dialectRequirements = (paymentHeader: string, requirement: PaymentRequirement) => {
    const { envelope, version } = inspectPaymentHeader(paymentHeader);
    return { envelope, requirements: version === 2 ? v2Requirements(requirement) : requirement };
  };
  return {
    async verify(paymentHeader, requirement) {
      const { envelope, requirements } = dialectRequirements(paymentHeader, requirement);
      let verified;
      try {
        verified = await client.verify(envelope, requirements);
      } catch (err) {
        classifyTransport(err);
      }
      if (!verified.isValid) {
        throw new GateError('verify_failed', verified.invalidReason ?? 'payment verification failed');
      }
    },
    async settle(paymentHeader, requirement) {
      const { envelope, requirements } = dialectRequirements(paymentHeader, requirement);
      let settled;
      try {
        settled = await client.settle(envelope, requirements);
      } catch (err) {
        classifyTransport(err);
      }
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
