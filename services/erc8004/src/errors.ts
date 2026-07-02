export type Erc8004ErrorCode = 'unknown_agent' | 'registration_failed' | 'bad_id' | 'feedback_failed';

/** A registry lookup or write that failed, with a machine-readable code. */
export class Erc8004Error extends Error {
  constructor(
    readonly code: Erc8004ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'Erc8004Error';
  }
}
