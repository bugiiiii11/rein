import { AsyncLocalStorage } from 'node:async_hooks';
import {
  AgentId,
  Receipt,
  newId,
  type Asset,
  type Decision,
  type PaymentIntent,
  type ReceiptSettlement,
  type TaskContext,
} from '@reinconsole/core';
import { EngineClient, type FetchLike } from './client.js';
import { PaymentBlockedError, UnsupportedRequirementError } from './errors.js';
import {
  PaymentRequired,
  selectRequirement,
  toIntentSubmission,
  type PaymentRequirement,
  type ResolvedRequirement,
} from './x402.js';
import {
  parsePaymentRequiredHeader,
  requirementFromV2,
  wrapPaymentV2,
  type ResourceInfoV2,
} from './x402v2.js';

/**
 * Builds the `X-PAYMENT` header for an allowed intent. Mock payers and the
 * local EIP-3009 payer ignore the decision; the session-key signer tier
 * requires it — the {intent, decision} pair is the engine-signed voucher the
 * signer verifies before any key is put to work.
 */
export type Payer = (
  requirement: PaymentRequirement,
  intent: PaymentIntent,
  decision: Decision,
) => string | Promise<string>;

export interface GuardOptions {
  /** Policy engine base URL, e.g. "http://localhost:8787". */
  engineUrl: string;
  /** The agent this guard speaks for (must be registered with the engine). */
  agentId: string;
  /** Base fetch the guard wraps by default (vendor-facing). Defaults to global fetch. */
  fetch?: FetchLike;
  /** Transport for talking to the policy engine. Defaults to global fetch. */
  engineFetch?: FetchLike;
  /** Task context attached to every intent unless overridden via withTask(). */
  taskContext?: TaskContext;
  /**
   * What a blocked payment looks like to the caller: 'throw' (default) raises
   * PaymentBlockedError; 'respond' returns a synthetic 402 JSON response, for
   * agent loops that prefer inspecting responses over catching.
   */
  onBlocked?: 'throw' | 'respond';
  /** If set, the guard settles allowed payments itself (pay + retry). */
  payer?: Payer;
  /** Extra token-address -> symbol mappings for asset resolution. */
  assetAddresses?: Record<string, Asset>;
  /** Called once per receipt, as it is recorded. */
  onReceipt?: (receipt: Receipt) => void;
}

/**
 * The Rein guard: wrap an agent's fetch once, and every x402 paywall it hits
 * is policy-checked before any payment exists, with a receipt either way.
 *
 * Layering: the guard wraps the BASE fetch, underneath any x402 payment
 * library. The first (unpaid) request surfaces the 402; the guard evaluates
 * it and either blocks — so the payment layer never sees the paywall — or
 * releases the 402 upward. The payment layer's `X-PAYMENT` retry then flows
 * back through the guard, which attaches the settlement to the receipt.
 * Alternatively, pass a `payer` and the guard completes the payment itself.
 */
export class Guard {
  readonly client: EngineClient;
  private readonly options: GuardOptions;
  private readonly baseFetch: FetchLike;
  private readonly task = new AsyncLocalStorage<TaskContext>();
  private readonly log: Receipt[] = [];
  /** Allowed-but-unsettled receipts awaiting the payment layer's retry, by URL. */
  private readonly pendingByUrl = new Map<string, Receipt>();

  constructor(options: GuardOptions) {
    AgentId.parse(options.agentId);
    this.options = options;
    const f = options.fetch ?? globalThis.fetch;
    this.baseFetch = (input, init) => f(input, init);
    this.client = new EngineClient({ baseUrl: options.engineUrl, fetch: options.engineFetch });
  }

  /** Every receipt this guard has recorded, oldest first. */
  receipts(): readonly Receipt[] {
    return this.log;
  }

  /** Run `fn` with a task context attached to every intent submitted inside it. */
  withTask<T>(context: TaskContext, fn: () => T): T {
    return this.task.run({ ...this.options.taskContext, ...context }, fn);
  }

  /**
   * The one-liner: returns a fetch-compatible function that enforces policy on
   * every x402 paywall. Wraps the guard's base fetch unless one is passed.
   */
  wrap(fetchImpl?: FetchLike): FetchLike {
    const inner: FetchLike = fetchImpl ? (input, init) => fetchImpl(input, init) : this.baseFetch;

    return async (input, init) => {
      const url = requestUrl(input);
      // A request that already carries a payment (either dialect's header) is
      // the release leg of an intent this guard allowed — pass it through and
      // capture settlement.
      if (
        readHeader(input, init, 'X-PAYMENT') !== null ||
        readHeader(input, init, 'PAYMENT-SIGNATURE') !== null
      ) {
        const res = await inner(input, init);
        this.settlePending(url, res);
        return res;
      }

      const res = await inner(input, init);
      if (res.status !== 402) return res;

      const paywall = await parse402(res, this.options.assetAddresses);
      // Not an x402 paywall — nothing to govern, hand it back untouched.
      if (!paywall) return res;

      const { resolved, wire, resource } = paywall;
      if (!resolved) throw new UnsupportedRequirementError(url);

      const taskContext = this.task.getStore() ?? this.options.taskContext;
      const submission = toIntentSubmission(resolved, url, this.options.agentId, taskContext);
      const { intent, decision } = await this.client.evaluate(submission);

      if (decision.outcome !== 'allow') {
        const receipt = this.record(intent, decision, url, init);
        if (this.options.onBlocked === 'respond') return blockedResponse(receipt);
        throw new PaymentBlockedError(intent, decision, receipt);
      }

      if (!this.options.payer) {
        // Advisory mode: release the 402 to the payment layer above us; its
        // X-PAYMENT retry will come back through and settle the receipt.
        const receipt = this.record(intent, decision, url, init);
        this.pendingByUrl.set(url, receipt);
        return res;
      }

      // The payer always produces the v1 envelope it knows; on a v2 paywall
      // the guard rewraps it (same signed payload, v2 PaymentPayload around
      // it) and pays on the v2 header. Every payer is v2-capable this way.
      const paymentHeader = await this.options.payer(resolved.requirement, intent, decision);
      const retry = await inner(
        input,
        wire === 2
          ? withHeader(
              input,
              init,
              'PAYMENT-SIGNATURE',
              wrapPaymentV2(paymentHeader, resolved.requirement, resource),
            )
          : withHeader(input, init, 'X-PAYMENT', paymentHeader),
      );
      this.record(intent, decision, url, init, parseSettlement(retry));
      return retry;
    };
  }

  private record(
    intent: PaymentIntent,
    decision: Decision,
    url: string,
    init: RequestInit | undefined,
    settlement?: ReceiptSettlement,
  ): Receipt {
    const receipt = Receipt.parse({
      id: newId('rcp'),
      agentId: intent.agentId,
      intentId: intent.id,
      decisionId: decision.id,
      outcome: decision.outcome,
      url,
      method: init?.method ?? 'GET',
      vendorHost: intent.vendor.host,
      amount: intent.amount,
      asset: intent.asset,
      chain: intent.chain,
      taskContext: intent.taskContext,
      reason: decision.reason,
      settlement,
      createdAt: new Date(),
    });
    this.log.push(receipt);
    this.options.onReceipt?.(receipt);
    return receipt;
  }

  private settlePending(url: string, res: Response): void {
    const receipt = this.pendingByUrl.get(url);
    if (!receipt || !res.ok) return;
    const settlement = parseSettlement(res);
    if (settlement) receipt.settlement = settlement;
    this.pendingByUrl.delete(url);
  }
}

/** Convenience factory mirroring the docs: `const guard = createGuard({...})`. */
export function createGuard(options: GuardOptions): Guard {
  return new Guard(options);
}

/** What a 402 offered, in whichever dialect the guard could govern. */
interface ParsedPaywall {
  /** The offer the guard selected, or undefined when none qualifies. */
  resolved: ResolvedRequirement | undefined;
  /** Which wire dialect to pay on: 2 = PAYMENT-SIGNATURE, 1 = X-PAYMENT. */
  wire: 1 | 2;
  /** The v2 402's shared resource info, echoed into the payment envelope. */
  resource?: ResourceInfoV2;
}

/**
 * Read a 402 in both dialects. v2 (the PAYMENT-REQUIRED header) is preferred
 * when it carries an offer the guard can govern; otherwise the v1 body gets
 * its chance — a dual-stack vendor is served on whichever channel works.
 * Returns undefined when neither channel is x402 at all (not a paywall).
 */
async function parse402(
  res: Response,
  assetAddresses: Record<string, Asset> | undefined,
): Promise<ParsedPaywall | undefined> {
  const v2 = parsePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED'));
  if (v2) {
    const resolved = selectRequirement(
      v2.accepts.map((offer) => requirementFromV2(offer, v2.resource)),
      assetAddresses,
    );
    if (resolved) {
      return v2.resource !== undefined
        ? { resolved, wire: 2, resource: v2.resource }
        : { resolved, wire: 2 };
    }
  }

  const body = await res
    .clone()
    .json()
    .catch(() => undefined);
  const parsed = PaymentRequired.safeParse(body);
  if (parsed.success) {
    return { resolved: selectRequirement(parsed.data.accepts, assetAddresses), wire: 1 };
  }
  // A v2 header alone still marks this as a paywall — one the guard must
  // fail closed on if nothing in it was governable.
  return v2 ? { resolved: undefined, wire: 2 } : undefined;
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function readHeader(
  input: string | URL | Request,
  init: RequestInit | undefined,
  name: string,
): string | null {
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  return source === undefined ? null : new Headers(source).get(name);
}

function withHeader(
  input: string | URL | Request,
  init: RequestInit | undefined,
  name: string,
  value: string,
): RequestInit {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set(name, value);
  return { ...init, headers };
}

/**
 * Decode the vendor's settlement header — `X-PAYMENT-RESPONSE` (v1) or
 * `PAYMENT-RESPONSE` (v2); base64 JSON per the x402 spec, plain JSON
 * tolerated mock-first. Absent or undecodable -> undefined.
 */
function parseSettlement(res: Response): ReceiptSettlement | undefined {
  const raw = res.headers.get('X-PAYMENT-RESPONSE') ?? res.headers.get('PAYMENT-RESPONSE');
  if (raw === null) return undefined;
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    try {
      payload = JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
    } catch {
      return { raw };
    }
  }
  const record =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {};
  return {
    // A failed v2 settle carries transaction: "" — no tx is no txHash.
    txHash:
      typeof record['transaction'] === 'string' && record['transaction'] !== ''
        ? record['transaction']
        : undefined,
    networkId: typeof record['network'] === 'string' ? record['network'] : undefined,
    raw,
  };
}

function blockedResponse(receipt: Receipt): Response {
  return new Response(
    JSON.stringify({
      error: 'payment_blocked_by_rein',
      outcome: receipt.outcome,
      reason: receipt.reason,
      intentId: receipt.intentId,
      decisionId: receipt.decisionId,
      receiptId: receipt.id,
    }),
    {
      status: 402,
      headers: { 'content-type': 'application/json', 'x-rein-outcome': receipt.outcome },
    },
  );
}
