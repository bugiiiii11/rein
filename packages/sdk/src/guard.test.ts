import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { newId } from '@reinconsole/core';
import { buildServer } from '@reinconsole/policy-engine';
import { createGuard } from './guard.js';
import { EngineClient, type FetchLike } from './client.js';
import { EngineError, PaymentBlockedError, UnsupportedRequirementError } from './errors.js';

/** A real policy engine on an ephemeral port -- the SDK talks actual HTTP. */
let app: ReturnType<typeof buildServer>;
let engineUrl: string;

beforeAll(async () => {
  app = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app.close();
});

/** Register a fresh agent so each test gets isolated rolling-budget state. */
async function newAgent(): Promise<string> {
  const client = new EngineClient({ baseUrl: engineUrl });
  const agent = await client.registerAgent({ orgId: newId('org'), name: 'sdk-test-agent' });
  return agent.id;
}

interface VendorCall {
  url: string;
  payment: string | null;
}

/**
 * An in-process x402 vendor: replies 402 with payment requirements until the
 * request carries X-PAYMENT, then serves the content plus a settlement header.
 */
function mockVendor(atomicPrice: string, overrides: Record<string, unknown> = {}) {
  const calls: VendorCall[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const payment = init?.headers ? new Headers(init.headers).get('X-PAYMENT') : null;
    calls.push({ url, payment });
    if (payment === null) {
      return new Response(
        JSON.stringify({
          x402Version: 1,
          accepts: [
            {
              scheme: 'exact',
              network: 'base',
              maxAmountRequired: atomicPrice,
              resource: new URL(url).pathname,
              payTo: '0xVENDOR',
              asset: 'USDC',
              ...overrides,
            },
          ],
          error: 'X-PAYMENT header is required',
        }),
        { status: 402, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ answer: 42 }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'X-PAYMENT-RESPONSE': Buffer.from(
          JSON.stringify({ success: true, transaction: '0xsettled', network: 'base' }),
        ).toString('base64'),
      },
    });
  };
  return { fetchImpl, calls };
}

const mockPayer = () => 'mock-payment-header';

describe('Guard (against a live policy engine)', () => {
  it('allows an in-policy payment, settles via the payer, and writes a receipt', async () => {
    const agentId = await newAgent();
    const vendor = mockVendor('10000'); // 0.01 USDC
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetchImpl, payer: mockPayer });
    await guard.client.addPolicy({
      policyId: 'pol_cap_allow',
      appliesTo: { agents: [agentId] },
      rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
      default: 'allow',
    });

    const res = await guard.wrap()('https://api.vendor.test/v1/answer');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 42 });
    expect(vendor.calls).toHaveLength(2);
    expect(vendor.calls[1]?.payment).toBe('mock-payment-header');

    const receipts = guard.receipts();
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.outcome).toBe('allow');
    expect(receipts[0]?.amount).toBe('0.01');
    expect(receipts[0]?.vendorHost).toBe('api.vendor.test');
    expect(receipts[0]?.settlement?.txHash).toBe('0xsettled');
  });

  it('blocks an over-cap payment before any payment is constructed', async () => {
    const agentId = await newAgent();
    const vendor = mockVendor('2000000'); // 2.00 USDC, over the 1.00 cap
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetchImpl, payer: mockPayer });
    await guard.client.addPolicy({
      policyId: 'pol_cap_deny',
      appliesTo: { agents: [agentId] },
      rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
      default: 'allow',
    });

    const err = await guard
      .wrap()('https://api.vendor.test/v1/answer')
      .then(() => undefined)
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(PaymentBlockedError);
    const blocked = err as PaymentBlockedError;
    expect(blocked.decision.outcome).toBe('deny');
    expect(blocked.decision.matchedRules).toContain('hard-cap');
    // The vendor was only hit once: the unpaid probe. No payment ever went out.
    expect(vendor.calls).toHaveLength(1);
    expect(guard.receipts()[0]?.outcome).toBe('deny');
    expect(guard.receipts()[0]?.settlement).toBeUndefined();
  });

  it("onBlocked: 'respond' returns a synthetic 402 instead of throwing", async () => {
    const agentId = await newAgent();
    const vendor = mockVendor('2000000');
    const guard = createGuard({
      engineUrl,
      agentId,
      fetch: vendor.fetchImpl,
      payer: mockPayer,
      onBlocked: 'respond',
    });
    await guard.client.addPolicy({
      policyId: 'pol_cap_respond',
      appliesTo: { agents: [agentId] },
      rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
      default: 'allow',
    });

    const res = await guard.wrap()('https://api.vendor.test/v1/answer');

    expect(res.status).toBe(402);
    expect(res.headers.get('x-rein-outcome')).toBe('deny');
    const body = (await res.json()) as { error: string; decisionId: string };
    expect(body.error).toBe('payment_blocked_by_rein');
    expect(body.decisionId).toMatch(/^dec_/);
  });

  it('escalate outcomes are blocked in v0.1', async () => {
    const agentId = await newAgent();
    const vendor = mockVendor('1000000'); // 1.00 USDC
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetchImpl, payer: mockPayer });
    await guard.client.addPolicy({
      policyId: 'pol_escalate',
      appliesTo: { agents: [agentId] },
      rules: [{ id: 'big-buy', escalate: { amountGt: '0.50' } }],
      default: 'allow',
    });

    await expect(guard.wrap()('https://api.vendor.test/v1/answer')).rejects.toMatchObject({
      decision: { outcome: 'escalate' },
    });
    expect(guard.receipts()[0]?.outcome).toBe('escalate');
  });

  it('advisory mode (no payer) releases the 402 and settles on the X-PAYMENT retry', async () => {
    const agentId = await newAgent();
    const vendor = mockVendor('10000');
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetchImpl });
    await guard.client.addPolicy({
      policyId: 'pol_advisory',
      appliesTo: { agents: [agentId] },
      default: 'allow',
    });
    const guarded = guard.wrap();
    const url = 'https://api.vendor.test/v1/answer';

    // First leg: the guard allows and hands the 402 to the payment layer.
    const first = await guarded(url);
    expect(first.status).toBe(402);
    expect(((await first.json()) as { accepts: unknown[] }).accepts).toHaveLength(1); // body still readable
    expect(guard.receipts()[0]?.outcome).toBe('allow');
    expect(guard.receipts()[0]?.settlement).toBeUndefined();

    // Second leg: the payment layer (e.g. x402-fetch) retries with X-PAYMENT.
    const second = await guarded(url, { headers: { 'X-PAYMENT': 'signed-by-x402-fetch' } });
    expect(second.status).toBe(200);
    expect(guard.receipts()).toHaveLength(1);
    expect(guard.receipts()[0]?.settlement?.txHash).toBe('0xsettled');
  });

  it('enforces rolling budgets across calls (second purchase denied)', async () => {
    const agentId = await newAgent();
    const vendor = mockVendor('10000'); // 0.01 USDC each
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetchImpl, payer: mockPayer });
    await guard.client.addPolicy({
      policyId: 'pol_budget',
      appliesTo: { agents: [agentId] },
      rules: [{ id: 'daily-budget', deny: { rollingSum: { window: '24h', gt: '0.015' } } }],
      default: 'allow',
    });
    const guarded = guard.wrap();

    const first = await guarded('https://api.vendor.test/v1/answer');
    expect(first.status).toBe(200);
    await expect(guarded('https://api.vendor.test/v1/answer')).rejects.toMatchObject({
      decision: { matchedRules: ['daily-budget'] },
    });
  });

  it('attaches withTask() context to the intent and receipt', async () => {
    const agentId = await newAgent();
    const vendor = mockVendor('10000');
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetchImpl, payer: mockPayer });
    await guard.client.addPolicy({
      policyId: 'pol_task',
      appliesTo: { agents: [agentId] },
      default: 'allow',
    });
    const guarded = guard.wrap();

    await guard.withTask({ taskId: 'task-7', purpose: 'market research' }, () =>
      guarded('https://api.vendor.test/v1/answer'),
    );

    expect(guard.receipts()[0]?.taskContext).toMatchObject({
      taskId: 'task-7',
      purpose: 'market research',
    });
  });

  it('passes non-402 responses and non-x402 402s through untouched', async () => {
    const agentId = await newAgent();
    const okFetch: FetchLike = async () => new Response('plain', { status: 200 });
    const plain402: FetchLike = async () =>
      new Response(JSON.stringify({ error: 'subscribe first' }), { status: 402 });

    const guardOk = createGuard({ engineUrl, agentId, fetch: okFetch });
    const resOk = await guardOk.wrap()('https://api.vendor.test/free');
    expect(resOk.status).toBe(200);
    expect(await resOk.text()).toBe('plain');
    expect(guardOk.receipts()).toHaveLength(0);

    const guard402 = createGuard({ engineUrl, agentId, fetch: plain402 });
    const res402 = await guard402.wrap()('https://api.vendor.test/legacy');
    expect(res402.status).toBe(402);
    expect(((await res402.json()) as { error: string }).error).toBe('subscribe first');
    expect(guard402.receipts()).toHaveLength(0);
  });

  it('fails closed on x402 offers it cannot govern', async () => {
    const agentId = await newAgent();
    const vendor = mockVendor('10000', { network: 'arbitrum' });
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetchImpl, payer: mockPayer });

    await expect(guard.wrap()('https://api.vendor.test/v1/answer')).rejects.toBeInstanceOf(
      UnsupportedRequirementError,
    );
    expect(vendor.calls).toHaveLength(1);
  });

  it('the kill switch (frozen agent) denies through the SDK path', async () => {
    const agentId = await newAgent();
    const vendor = mockVendor('10000');
    const guard = createGuard({ engineUrl, agentId, fetch: vendor.fetchImpl, payer: mockPayer });
    await guard.client.addPolicy({
      policyId: 'pol_frozen',
      appliesTo: { agents: [agentId] },
      default: 'allow',
    });
    await guard.client.freeze(agentId);

    await expect(guard.wrap()('https://api.vendor.test/v1/answer')).rejects.toMatchObject({
      decision: { outcome: 'deny', matchedRules: ['agent-frozen'] },
    });
  });
});

describe('EngineClient', () => {
  it('reports health with the decision-log public key', async () => {
    const client = new EngineClient({ baseUrl: engineUrl });
    const health = await client.health();
    expect(health.status).toBe('ok');
    expect(health.publicKey).toContain('BEGIN PUBLIC KEY');
  });

  it('surfaces engine validation failures as EngineError', async () => {
    const client = new EngineClient({ baseUrl: engineUrl });
    const err = await client
      .evaluate({
        agentId: 'not-an-agent-id',
        vendor: { host: 'x', address: 'y' },
        resource: '/r',
        amount: '1',
        asset: 'USDC',
        chain: 'base',
      })
      .then(() => undefined)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).status).toBe(400);
  });
});
