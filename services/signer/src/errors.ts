/**
 * Why the signer refused to sign. Every code is also emitted on the event bus
 * as `signature.refused`, so refusals are as observable as releases.
 */
export type RefusalCode =
  | 'session_unknown'
  | 'session_expired'
  | 'session_revoked'
  | 'agent_mismatch'
  | 'no_wallet'
  | 'voucher_invalid'
  | 'not_allowed'
  | 'decision_stale'
  | 'decision_replayed'
  | 'requirement_mismatch'
  | 'unsupported_network'
  | 'per_payment_cap_exceeded'
  | 'session_cap_exceeded';

/** A signing request the signer refused, with a machine-readable code. */
export class SignerError extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
  ) {
    super(message);
    this.name = 'SignerError';
  }
}
