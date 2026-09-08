import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { newId, type ApprovalVerdict } from '@reinconsole/core';
import {
  ApiKeyAuth,
  ApprovalService,
  PolicyEngine,
  buildServer,
  signApproval,
} from '@reinconsole/policy-engine';
import { createGuard } from './guard.js';
import { EngineClient, type FetchLike } from './client.js';
import { EngineError, PaymentBlockedError } from './errors.js';

/**
 * The SDK halves of A1 and A2: carrying an API key, and waiting out an
 * escalation until a signed verdict resolves it.
 */

const approverPair = generateKeyPairSync('ed25519');
const approverPem = approverPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();

let app: ReturnType<typeof buildServer>;
let engineUrl: string;
let approverId: string;
let adminSecret: string;
let runnerSecret: string;

beforeAll(async () => {
  const auth = new ApiKeyAuth();
  adminSecret = (await auth.issue({ name: 'ops', scopes: ['admin'] })).secret;
  runnerSecret = (await auth.issue({ name: 'fleet', scopes: ['evaluate', 'read', 'approve'] }))
    .secret;

  const approvals = new ApprovalService({ ttlMs: 5_000 });
  const engine = new PolicyEngine({ approvals });
  await engine.addPolicy({
    policyId: 'pol_review',
    rules: [{ id: 'big-ticket', escalate: { amountGt: '0.05' } }],
    default: 'allow',
  });
  approverId = (
    await approvals.registerApprover({ orgId: newId('org'), name: 'Finance', publicKey: approverPem })
  ).id;

  app = buildServer(engine, { auth });
  await app.listen({ port: 0, host: '127.0.0.1' });
  engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
});

function adminClient(): EngineClient {
  return new EngineClient({ baseUrl: engineUrl, apiKey: adminSecret });
}

/** A vendor that paywalls at $0.10 — above the escalation threshold. */
function mockVendor() {
  const fetchImpl: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const paid = init?.headers ? new Headers(init.headers).get('X-PAYMENT') : null;
    if (paid === null) {
      return new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: 'base',
              maxAmountRequired: '100000',
              resource: new URL(url).pathname,
              payTo: '0xVENDOR',
              asset: 'USDC',
            },
          ],
          error: 'X-PAYMENT header is required',
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ answer: 42 }), { status: 200 });
  };
  return fetchImpl;
}

/** Sign and submit a verdict the way an offline approver would. */
async function decide(decisionId: string, intentHash: string, verdict: ApprovalVerdict) {
  return adminClient().resolveApproval({
    decisionId,
    intentHash,
    verdict,
    approverKeyId: approverId,
    signature: signApproval(approverPair.privateKey, { decisionId, intentHash, verdict }),
  });
}

describe('engine API key, from the SDK side', () => {
  it('fails loudly with a 401 when no key is carried', async () => {
    const client = new EngineClient({ baseUrl: engineUrl });
    await expect(client.listAgents()).rejects.toBeInstanceOf(EngineError);
    await client.listAgents().catch((err: EngineError) => expect(err.status).toBe(401));
  });

  it('authenticates every call once a key is set', async () => {
    const agent = await adminClient().registerAgent({ orgId: newId('org'), name: 'keyed' });
    expect(agent.id).toMatch(/^agt_/);
    expect((await adminClient().health()).auth).toBe('api-key');
  });

  it('issues and rotates keys through the client', async () => {
    const issued = await adminClient().issueApiKey({ name: 'reader', scopes: ['read'] });
    const reader = new EngineClient({ baseUrl: engineUrl, apiKey: issued.secret });
    expect(await reader.listAgents()).toBeInstanceOf(Array);

    // A read key may not write: 403, not a silent no-op.
    await reader
      .registerAgent({ orgId: newId('org'), name: 'nope' })
      .then(() => expect.unreachable('a read key must not register agents'))
      .catch((err: EngineError) => expect(err.status).toBe(403));

    const rotated = await adminClient().rotateApiKey(issued.key.id, { graceMs: 0 });
    expect(rotated.secret).not.toBe(issued.secret);
    await reader.listAgents().catch((err: EngineError) => expect(err.status).toBe(401));
  });
});

describe('guard escalation await path', () => {
  it('blocks immediately when not asked to wait, and says it is still pending', async () => {
    const agent = await adminClient().registerAgent({ orgId: newId('org'), name: 'nowait' });
    const guard = createGuard({
      engineUrl,
      apiKey: runnerSecret,
      agentId: agent.id,
      fetch: mockVendor(),
    });

    const error = await guard
      .wrap()('https://api.vendor.com/v1/search')
      .then(() => undefined)
      .catch((err: unknown) => err as PaymentBlockedError);

    expect(error).toBeInstanceOf(PaymentBlockedError);
    expect(error?.decision.outcome).toBe('escalate');
    // Pending, not denied: a signed verdict can still release this payment.
    expect(error?.approval?.status).toBe('pending');
    expect(error?.message).toContain('[approval pending]');
  });

  it('waits, then pays on the follow-up decision once a signature approves it', async () => {
    const agent = await adminClient().registerAgent({ orgId: newId('org'), name: 'waiter' });
    const paid: string[] = [];
    const guard = createGuard({
      engineUrl,
      apiKey: runnerSecret,
      agentId: agent.id,
      fetch: mockVendor(),
      escalation: { await: true, pollMs: 25 },
      payer: (_req, _intent, decision) => {
        // The voucher the payer signs against is the APPROVED decision, not
        // the escalation that preceded it.
        paid.push(decision.outcome);
        return 'mock-payment-header';
      },
    });

    const inFlight = guard.wrap()('https://api.vendor.com/v1/search');

    // Approve out of band, the way a human with a key would.
    const pending = await waitForPending(agent.id);
    await decide(pending.decisionId, pending.intentHash, 'approve');

    const res = await inFlight;
    expect(res.status).toBe(200);
    expect(paid).toEqual(['allow']);

    const receipt = guard.receipts().at(-1);
    expect(receipt?.outcome).toBe('allow');
  });

  it('blocks with the deny decision when a signature rejects it', async () => {
    const agent = await adminClient().registerAgent({ orgId: newId('org'), name: 'rejected' });
    const guard = createGuard({
      engineUrl,
      apiKey: runnerSecret,
      agentId: agent.id,
      fetch: mockVendor(),
      escalation: { await: true, pollMs: 25 },
      payer: () => expect.unreachable('a rejected escalation must never reach the payer'),
    });

    const inFlight = guard
      .wrap()('https://api.vendor.com/v1/search')
      .then(() => undefined)
      .catch((err: unknown) => err as PaymentBlockedError);

    const pending = await waitForPending(agent.id);
    await decide(pending.decisionId, pending.intentHash, 'reject');

    const error = await inFlight;
    expect(error).toBeInstanceOf(PaymentBlockedError);
    expect(error?.decision.outcome).toBe('deny');
    expect(error?.approval?.status).toBe('rejected');
  });

  it('reports the pending approval in respond mode instead of throwing', async () => {
    const agent = await adminClient().registerAgent({ orgId: newId('org'), name: 'responder' });
    const guard = createGuard({
      engineUrl,
      apiKey: runnerSecret,
      agentId: agent.id,
      fetch: mockVendor(),
      onBlocked: 'respond',
    });

    const res = await guard.wrap()('https://api.vendor.com/v1/search');
    expect(res.status).toBe(402);
    const body = (await res.json()) as { outcome: string; approval?: { status: string } };
    expect(body.outcome).toBe('escalate');
    expect(body.approval?.status).toBe('pending');
  });
});

/** Poll the engine for this agent's parked escalation. */
async function waitForPending(agentId: string) {
  const client = new EngineClient({ baseUrl: engineUrl, apiKey: adminSecret });
  for (let i = 0; i < 100; i += 1) {
    const found = (await client.pendingApprovals()).find((r) => r.agentId === agentId);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`no escalation parked for ${agentId}`);
}
