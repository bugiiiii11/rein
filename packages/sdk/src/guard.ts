import { AsyncLocalStorage } from 'node:async_hooks';
import {
  AgentId,
  Receipt,
  newId,
  type ApprovalRequest,
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
  encodeBase64Json,
  parsePaymentRequiredHeader,
  requirementFromV2,
  wrapPaymentV2,
  type PaymentRequiredV2,
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
  /**
   * API-key secret for the engine. Required by any engine started with one;
   * without it every call comes back 401 as an EngineError.
   */
  apiKey?: string;
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
  /**
   * The networks this guard will govern payments on, as x402 ids in either
   * dialect (`base-sepolia`, `eip155:8453`, ...). A 402 offering only
   * networks outside the list is treated as an ungovernable paywall and
   * fails closed, BEFORE the engine is asked.
   *
   * Omitted means "any network the SDK maps to a chain", which is what every
   * guard got before profiles. Set it on anything holding a real key: the
   * engine cannot enforce this boundary for you, because policy is written
   * about chains and `networkToChain` folds `base-sepolia` into `base` (see
   * selectRequirement). A testnet agent without this list will happily be
   * allowed to pay a mainnet 402.
   */
  networks?: readonly string[];
  /** Called once per receipt, as it is recorded. */
  onReceipt?: (receipt: Receipt) => void;
  /**
   * How many receipts `receipts()` keeps, oldest evicted first. Default 1000.
   * The log is a session convenience; `onReceipt` sees every receipt, capped
   * or not, and is the path for anything that must not lose one. Without a
   * cap a long-lived guard -- an MCP server -- grows without bound.
   */
  maxReceipts?: number;
  /**
   * In advisory mode (no `payer`) an allowed 402 is released upward and its
   * receipt waits for the payment layer's X-PAYMENT retry to settle it. A
   * retry that never comes would leave that entry forever; after this many
   * milliseconds it is forgotten and the receipt stays unsettled -- which
   * reconciliation, not this log, is there to notice. Default 300 000: the
   * x402 authorization window, after which the retry could not pay anyway.
   */
  pendingTtlMs?: number;
  /**
   * Tell the engine when a payment settles, so reconciliation can close the
   * allowance (B1). On by default: without a report from somewhere, every
   * allowance the engine made reads as a gap, and the one component that sees
   * both the decision and the vendor's confirmation is this guard.
   *
   * Best-effort by construction — the report is fired and forgotten, and a
   * failed one never touches the payment. Telemetry must not be able to change
   * a payment's outcome. Set false where an independent indexer reports
   * instead, which is the stronger evidence: a guard reporting its own
   * settlement is the spender vouching for itself.
   */
  reportSettlement?: boolean;
  /**
   * What to do when policy escalates: by default nothing — the payment blocks
   * immediately, exactly as a deny does, and a human can still approve it out
   * of band. Set `await: true` and the guard holds the request open while it
   * waits for a signed verdict, then proceeds on an approval or blocks on a
   * rejection/expiry. Only ever wait where a stalled request is acceptable.
   */
  escalation?: EscalationOptions;
}

export interface EscalationOptions {
  /** Hold the request open until the escalation resolves. Default: false. */
  await?: boolean;
  /** Stop waiting after this long, leaving the request pending. Default 5 min. */
  timeoutMs?: number;
  /** How often to re-read the parked request. Default 1s. */
  pollMs?: number;
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
const DEFAULT_MAX_RECEIPTS = 1000;
const DEFAULT_PENDING_TTL_MS = 300_000;

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
    this.client = new EngineClient({
      baseUrl: options.engineUrl,
      ...(options.apiKey ? { apiKey: options.apiKey } : {}),
      ...(options.engineFetch ? { fetch: options.engineFetch } : {}),
    });
  }

  /** The most recent `maxReceipts` receipts this guard has recorded, oldest first. */
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

      const paywall = await parse402(res, this.options.assetAddresses, this.options.networks);
      // Not an x402 paywall — nothing to govern, hand it back untouched.
      if (!paywall) return res;

      const { resolved, wire, resource } = paywall;
      if (!resolved) throw new UnsupportedRequirementError(url);

      const taskContext = this.task.getStore() ?? this.options.taskContext;
      const submission = toIntentSubmission(resolved, url, this.options.agentId, taskContext);
      const evaluated = await this.client.evaluate(submission);
      const intent = evaluated.intent;
      let decision = evaluated.decision;
      let approval = evaluated.approval;

      // An escalation is a question, not yet an answer. When the caller has
      // opted into waiting, hold here until a signed verdict lands — the
      // decision we continue with is then the engine's FOLLOW-UP decision, the
      // one a signer will accept as a voucher.
      if (decision.outcome === 'escalate' && approval && this.options.escalation?.await) {
        const settled = await this.awaitEscalation(approval);
        approval = settled.request;
        if (settled.decision) decision = settled.decision;
      }

      if (decision.outcome !== 'allow') {
        const receipt = this.record(intent, decision, url, init);
        if (this.options.onBlocked === 'respond') return blockedResponse(receipt, approval);
        throw new PaymentBlockedError(intent, decision, receipt, approval);
      }

      if (!this.options.payer) {
        // Advisory mode: release the 402 to the payment layer above us; its
        // X-PAYMENT retry will come back through and settle the receipt.
        const receipt = this.record(intent, decision, url, init);
        this.sweepPending();
        this.pendingByUrl.set(url, receipt);
        // Only the offer that was actually evaluated. See ParsedPaywall.narrowed.
        return paywall.narrowed ?? res;
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
    const max = this.options.maxReceipts ?? DEFAULT_MAX_RECEIPTS;
    if (this.log.length > max) this.log.splice(0, this.log.length - max);
    this.options.onReceipt?.(receipt);
    if (settlement) this.announceSettlement(receipt);
    return receipt;
  }

  /**
   * Fire-and-forget the settlement fact at the engine. Deliberately silent on
   * failure: a reconciliation report that never arrives leaves a gap open,
   * which is the SAFE direction — an operator sees a payment they must check.
   * Raising here would let telemetry break a payment that already succeeded.
   *
   * The amount is not reported: the guard knows what it was asked to pay, not
   * what the chain moved, and a settlement report should carry only what its
   * reporter actually observed.
   */
  private announceSettlement(receipt: Receipt): void {
    if (this.options.reportSettlement === false) return;
    const txHash = receipt.settlement?.txHash;
    void this.client
      .reportSettlement({
        intentId: receipt.intentId,
        ...(txHash !== undefined ? { txHash } : {}),
        chain: receipt.chain,
        source: 'guard',
        confirmedAt: receipt.createdAt,
      })
      .catch(() => undefined);
  }

  /**
   * Wait out a parked escalation. Never waits past the request's own TTL:
   * after that instant the engine can only deny it, so continuing to poll
   * would just be a slower block.
   */
  private async awaitEscalation(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const options = this.options.escalation ?? {};
    const untilExpiry = Math.max(0, request.expiresAt.getTime() - Date.now()) + 1_000;
    const view = await this.client.awaitApproval(request.decisionId, {
      timeoutMs: Math.min(options.timeoutMs ?? 300_000, untilExpiry),
      ...(options.pollMs !== undefined ? { pollMs: options.pollMs } : {}),
    });
    return { request: view.request, ...(view.decision ? { decision: view.decision } : {}) };
  }

  /** Drop advisory receipts whose retry window has passed -- see `pendingTtlMs`. */
  private sweepPending(): void {
    const cutoff = Date.now() - (this.options.pendingTtlMs ?? DEFAULT_PENDING_TTL_MS);
    for (const [url, receipt] of this.pendingByUrl) {
      if (receipt.createdAt.getTime() < cutoff) this.pendingByUrl.delete(url);
    }
  }

  private settlePending(url: string, res: Response): void {
    this.sweepPending();
    const receipt = this.pendingByUrl.get(url);
    if (!receipt || !res.ok) return;
    const settlement = parseSettlement(res);
    if (settlement) {
      receipt.settlement = settlement;
      this.announceSettlement(receipt);
    }
    this.pendingByUrl.delete(url);
  }
}

/** How a waited-on escalation came out. */
interface ApprovalOutcome {
  request: ApprovalRequest;
  /** The follow-up allow/deny decision, absent while still pending. */
  decision?: Decision;
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
  /**
   * The same 402 carrying ONLY the offer the guard evaluated.
   *
   * In advisory mode the guard does not pay; it hands the 402 back to the
   * payment layer above, which holds the key. Releasing the vendor's body
   * verbatim meant that layer chose from the FULL `accepts` list -- including
   * the offers the network allow-list had just rejected. A hostile 402 that
   * lists a 0.001 Sepolia offer and a 250 USDC mainnet one gets the cheap one
   * evaluated and allowed, and the expensive one paid, while the receipt and
   * the engine record the cheap one. Narrowing the body is what makes the
   * testnet pin structural rather than advisory.
   */
  narrowed?: Response;
}

/** Rebuild a 402 carrying a single offer, in whichever dialects it used. */
function narrow402(
  res: Response,
  body: unknown,
  v2: PaymentRequiredV2 | undefined,
  keepV1: PaymentRequirement | undefined,
  keepV2Index: number | undefined,
): Response {
  const headers = new Headers(res.headers);
  if (v2 && keepV2Index !== undefined) {
    const offer = v2.accepts[keepV2Index];
    if (offer) headers.set('PAYMENT-REQUIRED', encodeBase64Json({ ...v2, accepts: [offer] }));
  }
  let text: string | undefined;
  if (keepV1 && body && typeof body === 'object') {
    text = JSON.stringify({ ...(body as Record<string, unknown>), accepts: [keepV1] });
    headers.delete('content-length');
  }
  return new Response(text ?? res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
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
  networks: readonly string[] | undefined,
): Promise<ParsedPaywall | undefined> {
  const v2 = parsePaymentRequiredHeader(res.headers.get('PAYMENT-REQUIRED'));
  const body = await res
    .clone()
    .json()
    .catch(() => undefined);
  const parsed = PaymentRequired.safeParse(body);

  // Which v1 offer (if the body is v1) the guard would govern. Computed even
  // on the v2 path, because a dual-stack 402 answers both and a v1-only layer
  // above would otherwise still read the unfiltered body.
  const v1Resolved = parsed.success
    ? selectRequirement(parsed.data.accepts, assetAddresses, networks)
    : undefined;

  if (v2) {
    const asRequirements = v2.accepts.map((offer) => requirementFromV2(offer, v2.resource));
    const resolved = selectRequirement(asRequirements, assetAddresses, networks);
    if (resolved) {
      const index = asRequirements.indexOf(resolved.requirement);
      const narrowed = narrow402(res, body, v2, v1Resolved?.requirement, index);
      return v2.resource !== undefined
        ? { resolved, wire: 2, resource: v2.resource, narrowed }
        : { resolved, wire: 2, narrowed };
    }
  }

  if (parsed.success) {
    return {
      resolved: v1Resolved,
      wire: 1,
      ...(v1Resolved
        ? { narrowed: narrow402(res, body, v2, v1Resolved.requirement, undefined) }
        : {}),
    };
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

function blockedResponse(receipt: Receipt, approval?: ApprovalRequest): Response {
  return new Response(
    JSON.stringify({
      error: 'payment_blocked_by_rein',
      outcome: receipt.outcome,
      reason: receipt.reason,
      intentId: receipt.intentId,
      decisionId: receipt.decisionId,
      receiptId: receipt.id,
      // `pending` here means a signed verdict could still release this
      // payment; anything else is final.
      ...(approval
        ? {
            approval: {
              status: approval.status,
              decisionId: approval.decisionId,
              expiresAt: approval.expiresAt.toISOString(),
            },
          }
        : {}),
    }),
    {
      status: 402,
      headers: { 'content-type': 'application/json', 'x-rein-outcome': receipt.outcome },
    },
  );
}
