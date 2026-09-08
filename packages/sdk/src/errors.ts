import type { ApprovalRequest, Decision, PaymentIntent, Receipt } from '@reinconsole/core';

/** Base class for everything the SDK throws, so callers can catch broadly. */
export class ReinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** The policy engine answered with a non-2xx status. */
export class EngineError extends ReinError {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message = `policy engine responded ${status}`,
  ) {
    super(message);
  }
}

/**
 * The engine evaluated the intent and did NOT allow it. The payment was never
 * constructed, so no funds moved. Carries the full evidence trail.
 *
 * When the outcome was `escalate`, `approval` carries the parked request — and
 * its `status` says which kind of block this is: `pending` means a signed
 * verdict could still release it (the guard stopped waiting, or was never
 * asked to), while `rejected`/`expired` are final. An absent `approval` on an
 * escalation means the engine has no approval tier at all: nothing can
 * release it.
 */
export class PaymentBlockedError extends ReinError {
  constructor(
    readonly intent: PaymentIntent,
    readonly decision: Decision,
    readonly receipt: Receipt,
    readonly approval?: ApprovalRequest,
  ) {
    super(
      `rein blocked payment of ${intent.amount} ${intent.asset} to ${intent.vendor.host}: ` +
        `${decision.outcome}${decision.reason ? ` (${decision.reason})` : ''}` +
        (approval ? ` [approval ${approval.status}]` : ''),
    );
  }
}

/**
 * The vendor's 402 was x402-shaped but offered no requirement the guard can
 * govern (unknown scheme/network/asset). The guard fails closed rather than
 * letting an ungoverned payment through.
 */
export class UnsupportedRequirementError extends ReinError {
  constructor(readonly url: string) {
    super(`no supported x402 payment requirement in 402 from ${url}; failing closed`);
  }
}
