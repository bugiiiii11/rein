export type RailsErrorCode =
  | 'malformed_payment'
  | 'unsupported_network'
  /** The requirement names a token that is not the pinned profile's USDC. */
  | 'unsupported_asset';

/** A payload or requirement these rails refuse to handle, with a machine-readable code. */
export class RailsError extends Error {
  constructor(
    readonly code: RailsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'RailsError';
  }
}

/** The facilitator answered with a non-2xx status; body kept for forensics. */
export class FacilitatorHttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`facilitator responded ${status}: ${body.slice(0, 500)}`);
    this.name = 'FacilitatorHttpError';
  }
}
