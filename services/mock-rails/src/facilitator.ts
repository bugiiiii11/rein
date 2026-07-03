import type { Asset } from '@reinconsole/core';
import {
  atomicToDecimal,
  networkToChain,
  requirementDecimals,
  resolveAsset,
  type PaymentRequirement,
  type Payer,
} from '@reinconsole/sdk';
import { FacilitatorError } from './errors.js';
import { MockLedger, type LedgerEntry } from './ledger.js';
import {
  decodePaymentHeader,
  encodePaymentHeader,
  encodeSettlementHeader,
  type MockPaymentHeader,
  type SettlementResponse,
} from './payload.js';

export interface MockFacilitatorOptions {
  ledger: MockLedger;
  /** Recorded on settled payments (shows up in SettledPayment.facilitator). */
  name?: string;
  /** Extra token-address -> symbol mappings, mirroring the guard's option. */
  assetAddresses?: Record<string, Asset>;
}

export interface SettleResult {
  response: SettlementResponse;
  /** Ready-made value for the vendor's X-PAYMENT-RESPONSE header. */
  header: string;
  /** The transfer as written on the mock chain. */
  entry: LedgerEntry;
}

/**
 * The mock x402 facilitator: verifies X-PAYMENT headers and "settles" them by
 * writing transfers onto the mock ledger. Plays the role Coinbase's hosted
 * facilitator plays in production — vendors call `settle()`, agents pay via
 * `payerFor()`, and nothing here is Rein-privileged: settlement happens
 * whether or not a policy engine ever saw the payment. Catching the ones it
 * didn't see is the indexer's job.
 */
export class MockFacilitator {
  readonly name: string;
  private readonly ledger: MockLedger;
  private readonly assetAddresses: Record<string, Asset>;

  constructor(options: MockFacilitatorOptions) {
    this.ledger = options.ledger;
    this.name = options.name ?? 'mock-facilitator';
    this.assetAddresses = options.assetAddresses ?? {};
  }

  /**
   * A `Payer` for the SDK guard: builds the X-PAYMENT header for an allowed
   * intent, stamping the intent id so settlement reconciles exactly. This is
   * the plug-in point the real x402 signer replaces.
   */
  payerFor(fromAddress: string): Payer {
    return (requirement, intent) =>
      encodePaymentHeader({
        x402Version: 1,
        scheme: requirement.scheme,
        network: requirement.network,
        payload: {
          from: fromAddress,
          to: requirement.payTo,
          value: requirement.maxAmountRequired,
          asset: requirement.asset,
          intentId: intent.id,
          nonce: intent.nonce,
        },
      });
  }

  /** Verify an X-PAYMENT header against the requirement it claims to satisfy. */
  verify(paymentHeader: string, requirement: PaymentRequirement): MockPaymentHeader {
    const header = decodePaymentHeader(paymentHeader);
    if (header.scheme.toLowerCase() !== 'exact' || requirement.scheme.toLowerCase() !== 'exact') {
      throw new FacilitatorError(
        'unsupported_scheme',
        `mock facilitator only settles "exact", got "${header.scheme}"/"${requirement.scheme}"`,
      );
    }
    if (header.network !== requirement.network) {
      throw new FacilitatorError(
        'network_mismatch',
        `payment is on "${header.network}" but the requirement wants "${requirement.network}"`,
      );
    }
    if (!networkToChain(header.network)) {
      throw new FacilitatorError('unsupported_network', `unknown network "${header.network}"`);
    }
    if (header.payload.value !== requirement.maxAmountRequired) {
      throw new FacilitatorError(
        'amount_mismatch',
        `payment of ${header.payload.value} does not match required ${requirement.maxAmountRequired}`,
      );
    }
    if (header.payload.to !== requirement.payTo) {
      throw new FacilitatorError(
        'recipient_mismatch',
        `payment pays "${header.payload.to}" but the requirement pays "${requirement.payTo}"`,
      );
    }
    return header;
  }

  /**
   * Verify, then settle: write the transfer on the mock chain and return the
   * settlement response the vendor relays via X-PAYMENT-RESPONSE.
   */
  settle(paymentHeader: string, requirement: PaymentRequirement): SettleResult {
    const header = this.verify(paymentHeader, requirement);
    const chain = networkToChain(header.network);
    if (!chain) throw new FacilitatorError('unsupported_network', `unknown network "${header.network}"`);
    const asset = resolveAsset(requirement, this.assetAddresses);
    if (!asset) {
      throw new FacilitatorError('unsupported_asset', `cannot resolve asset "${requirement.asset}"`);
    }
    const entry = this.ledger.transfer({
      chain,
      asset,
      from: header.payload.from,
      to: header.payload.to,
      amount: atomicToDecimal(header.payload.value, requirementDecimals(requirement)),
      memo: header.payload.intentId,
    });
    const response: SettlementResponse = {
      success: true,
      transaction: entry.txHash,
      network: header.network,
      payer: header.payload.from,
    };
    return { response, header: encodeSettlementHeader(response), entry };
  }
}
