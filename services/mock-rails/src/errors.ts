export type FacilitatorErrorCode =
  | 'malformed_payment'
  | 'unsupported_scheme'
  | 'unsupported_network'
  | 'unsupported_asset'
  | 'network_mismatch'
  | 'amount_mismatch'
  | 'recipient_mismatch';

/** A payment the facilitator refused to settle, with a machine-readable code. */
export class FacilitatorError extends Error {
  constructor(
    readonly code: FacilitatorErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FacilitatorError';
  }
}
