import { z } from 'zod';
import {
  Agent,
  ApiKey,
  ApprovalChallenges,
  ApprovalGrant,
  ApprovalRequest,
  ApproverKey,
  Breaker,
  Decision,
  PaymentIntent,
  Policy,
  type ApiKeyScope,
} from '@reinconsole/core';
import { EngineError } from './errors.js';
import type { IntentSubmission } from './x402.js';

/** Any fetch-compatible function (global fetch, undici, or a test double). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * One breaker's standing for one agent, as the engine reports it. Mirrors the
 * engine's `BreakerState`; declared here so the client validates the wire
 * shape rather than trusting it.
 */
export const BreakerState = z.object({
  breaker: Breaker,
  policyId: z.string(),
  txCount: z.number(),
  sum: z.string(),
  countingFrom: z.number(),
  resetAt: z.number().optional(),
  tripped: z.boolean(),
  reason: z.string().optional(),
});
export type BreakerState = z.infer<typeof BreakerState>;

const Health = z.object({
  status: z.string(),
  publicKey: z.string(),
  /** "api-key" once the engine demands a credential; "none" while it does not. */
  auth: z.string().optional(),
  approvals: z.string().optional(),
});

const EvaluateResponse = z.object({
  intent: PaymentIntent,
  decision: Decision,
  /** Present when an escalation was parked for a signed verdict. */
  approval: ApprovalRequest.optional(),
});
export type EvaluateResponse = z.infer<typeof EvaluateResponse>;

/** A parked escalation plus the bytes to sign and, once resolved, its decision. */
const ApprovalView = z.object({
  request: ApprovalRequest,
  challenges: ApprovalChallenges,
  /** The follow-up allow/deny decision, once the request has resolved. */
  decision: Decision.optional(),
});
export type ApprovalView = z.infer<typeof ApprovalView>;

const ResolveResponse = z.object({ request: ApprovalRequest, decision: Decision });
export type ResolveResponse = z.infer<typeof ResolveResponse>;

const IssuedApiKey = z.object({ key: ApiKey, secret: z.string() });
export type IssuedApiKey = z.infer<typeof IssuedApiKey>;

export interface EngineClientOptions {
  /** Base URL of the policy engine, e.g. "http://localhost:8787". */
  baseUrl: string;
  /**
   * API-key secret, sent as `Authorization: Bearer`. Required by any engine
   * started with one; omit only for a local engine running without auth.
   */
  apiKey?: string;
  /** Override the transport (tests, custom agents). Defaults to global fetch. */
  fetch?: FetchLike;
}

export interface AwaitApprovalOptions {
  /** Give up after this long and return the still-pending view. */
  timeoutMs?: number;
  /** How often to re-read the request. */
  pollMs?: number;
  /** Abort the wait early (an agent loop shutting down). */
  signal?: AbortSignal;
}

/**
 * Thin typed client for the policy-engine HTTP API. Every response is parsed
 * through the @reinconsole/core schemas, so wire drift fails loudly at the boundary.
 */
export class EngineClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly apiKey: string | undefined;

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const f = options.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => f(input, init);
    this.apiKey = options.apiKey;
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    body?: unknown,
  ): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.apiKey) headers['authorization'] = `Bearer ${this.apiKey}`;
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!res.ok) {
      const payload = await res
        .clone()
        .json()
        .catch(() => res.text().catch(() => undefined));
      throw new EngineError(res.status, payload);
    }
    if (res.status === 204) return schema.parse(undefined);
    return schema.parse(await res.json());
  }

  health(): Promise<z.infer<typeof Health>> {
    return this.request('GET', '/health', Health);
  }

  registerAgent(input: {
    orgId: string;
    name: string;
    erc8004Id?: string;
    /** Semantic grouping labels (lowercase slugs) — policy `appliesTo.labels` targets these. */
    labels?: Agent['labels'];
    wallets?: Agent['wallets'];
  }): Promise<Agent> {
    return this.request('POST', '/v1/agents', Agent, input);
  }

  listAgents(): Promise<Agent[]> {
    return this.request('GET', '/v1/agents', z.array(Agent));
  }

  freeze(agentId: string): Promise<void> {
    return this.request('POST', `/v1/agents/${agentId}/freeze`, z.void());
  }

  unfreeze(agentId: string): Promise<void> {
    return this.request('POST', `/v1/agents/${agentId}/unfreeze`, z.void());
  }

  /**
   * Where the agent's behavioral breakers stand. Read-only: nothing here can
   * trip or clear one — a breaker clears when its window rolls forward or
   * when a signed approval moves its floor.
   */
  breakerStates(agentId: string): Promise<BreakerState[]> {
    return this.request('GET', `/v1/agents/${agentId}/breakers`, z.array(BreakerState));
  }

  addPolicy(policy: z.input<typeof Policy>): Promise<Policy> {
    return this.request('POST', '/v1/policies', Policy, policy);
  }

  listPolicies(): Promise<Policy[]> {
    return this.request('GET', '/v1/policies', z.array(Policy));
  }

  /** The hot path: submit an intent, get the normalized intent + signed decision. */
  evaluate(submission: IntentSubmission): Promise<EvaluateResponse> {
    return this.request('POST', '/v1/evaluate', EvaluateResponse, submission);
  }

  decisions(): Promise<Decision[]> {
    return this.request('GET', '/v1/decisions', z.array(Decision));
  }

  // --- API keys (admin scope) ---

  /** Mint a key. The secret in the response is the only copy that will exist. */
  issueApiKey(input: { name: string; scopes: ApiKeyScope[] }): Promise<IssuedApiKey> {
    return this.request('POST', '/v1/keys', IssuedApiKey, input);
  }

  listApiKeys(): Promise<ApiKey[]> {
    return this.request('GET', '/v1/keys', z.array(ApiKey));
  }

  /**
   * Mint a replacement secret. The outgoing one keeps working for `graceMs`
   * (engine default: 1h) so callers can be redeployed one at a time; pass 0
   * when the old secret is compromised and must die now.
   */
  rotateApiKey(keyId: string, options: { graceMs?: number } = {}): Promise<IssuedApiKey> {
    return this.request('POST', `/v1/keys/${keyId}/rotate`, IssuedApiKey, options);
  }

  revokeApiKey(keyId: string): Promise<ApiKey> {
    return this.request('POST', `/v1/keys/${keyId}/revoke`, ApiKey);
  }

  // --- Approvals ---

  /** Register the PUBLIC half of an approver key. The private half never travels. */
  registerApprover(input: { orgId: string; name: string; publicKey: string }): Promise<ApproverKey> {
    return this.request('POST', '/v1/approvers', ApproverKey, input);
  }

  listApprovers(): Promise<ApproverKey[]> {
    return this.request('GET', '/v1/approvers', z.array(ApproverKey));
  }

  revokeApprover(keyId: string): Promise<ApproverKey> {
    return this.request('POST', `/v1/approvers/${keyId}/revoke`, ApproverKey);
  }

  /** Every escalation still answerable right now. */
  pendingApprovals(): Promise<ApprovalRequest[]> {
    return this.request('GET', '/v1/approvals', z.array(ApprovalRequest));
  }

  /** One escalation, with the exact bytes to sign for each verdict. */
  approval(decisionId: string): Promise<ApprovalView> {
    return this.request('GET', `/v1/approvals/${decisionId}`, ApprovalView);
  }

  /**
   * Submit a signed verdict. The signature is the authority — this call can be
   * made by anyone, from anywhere, including a relay that never sees a key.
   */
  resolveApproval(grant: ApprovalGrant): Promise<ResolveResponse> {
    const { decisionId, ...body } = ApprovalGrant.parse(grant);
    return this.request('POST', `/v1/approvals/${decisionId}/resolve`, ResolveResponse, body);
  }

  /**
   * Poll until an escalation resolves, times out, or the caller aborts. The
   * returned view is whatever was true when polling stopped — a caller must
   * check `request.status` rather than assume it resolved.
   */
  async awaitApproval(
    decisionId: string,
    options: AwaitApprovalOptions = {},
  ): Promise<ApprovalView> {
    const pollMs = options.pollMs ?? 1_000;
    const deadline = Date.now() + (options.timeoutMs ?? 300_000);
    for (;;) {
      const view = await this.approval(decisionId);
      if (view.request.status !== 'pending') return view;
      if (options.signal?.aborted || Date.now() + pollMs > deadline) return view;
      await sleep(pollMs, options.signal);
    }
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}
