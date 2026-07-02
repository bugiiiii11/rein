/**
 * Why the gate turned a payment away. Stable strings — clients switch on these.
 *
 * Two classes carry no payer fault and MUST NOT feed reputation evidence
 * (@rein/graph skips them): the throttle codes (`rate_limited`,
 * `velocity_exceeded` — the vendor's cap, not payer misbehavior) and the rails
 * codes (`rails_unavailable`, `settle_unknown` — the vendor's infrastructure
 * failing; a settle_unknown payment may even have gone through).
 */
export type GateRefusalCode =
  | 'malformed_payment'
  | 'scheme_mismatch'
  | 'network_mismatch'
  | 'amount_mismatch'
  | 'recipient_mismatch'
  | 'payer_denied'
  | 'payer_not_allowed'
  | 'payment_replayed'
  /** Too many presentations in the velocity window (429; Retry-After set). */
  | 'rate_limited'
  /** The settled-spend cap would be exceeded (429; Retry-After when a slot frees). */
  | 'velocity_exceeded'
  | 'verify_failed'
  | 'settle_failed'
  /** The rails could not be reached and the payment provably did NOT settle
   *  (503). The replay slot is released — the same header may be re-presented. */
  | 'rails_unavailable'
  /** Settlement was attempted but its fate is unknown — the request may have
   *  reached the rails (503). The slot stays burned; do NOT re-pay blindly:
   *  reconcile against transaction records (e.g. the on-chain indexer) first. */
  | 'settle_unknown';

export class GateError extends Error {
  /** Seconds until the refused payment could be admitted (throttle codes). */
  readonly retryAfterSeconds?: number;

  constructor(
    readonly code: GateRefusalCode,
    message: string,
    options: { retryAfterSeconds?: number } = {},
  ) {
    super(message);
    this.name = 'GateError';
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
