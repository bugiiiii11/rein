import { z } from 'zod';
import { Agent, Decision, PaymentIntent, Policy } from '@reinconsole/core';
import { EngineError } from './errors.js';
import type { IntentSubmission } from './x402.js';

/** Any fetch-compatible function (global fetch, undici, or a test double). */
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const Health = z.object({ status: z.string(), publicKey: z.string() });
const EvaluateResponse = z.object({ intent: PaymentIntent, decision: Decision });
export type EvaluateResponse = z.infer<typeof EvaluateResponse>;

export interface EngineClientOptions {
  /** Base URL of the policy engine, e.g. "http://localhost:8787". */
  baseUrl: string;
  /** Override the transport (tests, custom agents). Defaults to global fetch. */
  fetch?: FetchLike;
}

/**
 * Thin typed client for the policy-engine HTTP API. Every response is parsed
 * through the @reinconsole/core schemas, so wire drift fails loudly at the boundary.
 */
export class EngineClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(options: EngineClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    const f = options.fetch ?? globalThis.fetch;
    this.fetchImpl = (input, init) => f(input, init);
  }

  private async request<T>(
    method: string,
    path: string,
    schema: z.ZodType<T, z.ZodTypeDef, unknown>,
    body?: unknown,
  ): Promise<T> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
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
}
