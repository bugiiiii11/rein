/** Why the gate turned a payment away. Stable strings — clients switch on these. */
export type GateRefusalCode =
  | 'malformed_payment'
  | 'scheme_mismatch'
  | 'network_mismatch'
  | 'amount_mismatch'
  | 'recipient_mismatch'
  | 'payer_denied'
  | 'payer_not_allowed'
  | 'payment_replayed'
  | 'verify_failed'
  | 'settle_failed';

export class GateError extends Error {
  constructor(
    readonly code: GateRefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'GateError';
  }
}
