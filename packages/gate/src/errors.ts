/**
 * Why the gate turned a payment away. Stable strings — clients switch on these.
 *
 * Two classes carry no payer fault and MUST NOT feed reputation evidence
 * (@reinconsole/graph skips them): the throttle codes (`rate_limited`,
 * `velocity_exceeded` — the vendor's cap, not payer misbehavior) and the rails
 * codes (`rails_unavailable`, `settle_unknown` — the vendor's infrastructure
 * failing; a settle_unknown payment may even have gone through), and the
 * surge codes (`price_unavailable`, `price_ceiling` -- the vendor declining
 * to quote).
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
  | 'settle_unknown'
  /** Surge pricing could not learn what a settlement costs, so it quotes
   *  nothing (503; Retry-After set). Never falls back to the list price. */
  | 'price_unavailable'
  /** Settlement cost would price the route above its surge ceiling (503;
   *  Retry-After set). The vendor declines to sell until the cost falls. */
  | 'price_ceiling';

export class GateError extends Error {
  /** Seconds until the refused payment could be admitted (throttle codes). */
  readonly retryAfterSeconds?: number;
  /**
   * The rails' own failed settlement response, when there is one (a
   * facilitator settle that answered `success: false`). Refusals of v2
   * payments relay it verbatim in the PAYMENT-RESPONSE header instead of a
   * synthesized one, so the payer sees the facilitator's real errorReason.
   */
  readonly paymentResponse?: unknown;

  constructor(
    readonly code: GateRefusalCode,
    message: string,
    options: { retryAfterSeconds?: number; paymentResponse?: unknown } = {},
  ) {
    super(message);
    this.name = 'GateError';
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.paymentResponse = options.paymentResponse;
  }
}
