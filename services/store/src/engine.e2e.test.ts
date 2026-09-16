/**
 * The engine e2e: the deployable bin, driven the way an external agent will
 * drive the hosted one. Mock rails, always on -- `engine.e2e.live.test.ts` is
 * the same loop on Base Sepolia behind RUN_LIVE. See `engine-e2e.ts` for why
 * this spawns the bin rather than composing the server in-process.
 *
 *   register agent + policy (operator key)
 *     -> issue the agent a NARROWER key (read + evaluate)
 *     -> SDK guard on that key pays a gated vendor through the mock facilitator
 *     -> the guard reports the settlement; reconciliation closes to zero gaps
 *     -> a payment over the cap is denied and never reaches the rails
 *     -> the MCP tool surface drives the same loop
 *     -> SIGTERM, respawn on the same data dir: chain, settlements, key survive
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId } from '@reinconsole/core';
import { createGate, createGatedFetch, mockFacilitatorRails } from '@reinconsole/gate';
import { createToolContext, reinTools } from '@reinconsole/mcp';
import { MockFacilitator, MockLedger } from '@reinconsole/mock-rails';
import {
  EngineClient,
  EngineError,
  PaymentBlockedError,
  createGuard,
  type FetchLike,
} from '@reinconsole/sdk';
import { engineUnderTest, until, type EngineUnderTest } from './engine-e2e.js';

const remote = Boolean(process.env['REIN_E2E_ENGINE_URL']?.trim());
const WALLET = '0x4b64d60ee40a9bf3108c5c09cc25AFC9a971958F';
const VENDOR = '0xE239D0281fc9B524DCBdA81Ffd89F4f5bed1383E';
/** Priced under the policy cap. */
const CHEAP = 'https://vendor.e2e.test/v1/answer';
/** Priced over it. */
const DEAR = 'https://vendor.e2e.test/v1/premium';

let engine: EngineUnderTest;
let admin: EngineClient;
let agentId: string;
/** The read+evaluate secret the agent actually holds. */
let agentSecret: string;
let ledger: MockLedger;
let facilitator: MockFacilitator;
let vendorFetch: FetchLike;

beforeAll(async () => {
  engine = await engineUnderTest();
  admin = new EngineClient({ baseUrl: engine.url, apiKey: engine.adminSecret });

  const agent = await admin.registerAgent({
    orgId: newId('org'),
    name: 'e2e-agent',
    wallets: [{ chain: 'base', address: WALLET, mode: 'sdk' }],
  });
  agentId = agent.id;
  await admin.addPolicy({
    policyId: newId('pol'),
    appliesTo: { agents: [agentId] },
    rules: [{ id: 'tx-cap', deny: { amountGt: '0.05' } }],
    default: 'allow',
  });
  // The agent holds a narrower key than the operator: it can evaluate and
  // read, never write policy. That is the deployment shape, so it is the
  // shape under test.
  agentSecret = (await admin.issueApiKey({ name: 'e2e-agent', scopes: ['read', 'evaluate'] }))
    .secret;

  ledger = new MockLedger();
  facilitator = new MockFacilitator({ ledger });
  vendorFetch = createGatedFetch(
    createGate({
      routes: [
        { path: '/v1/answer', price: '0.01' },
        { path: '/v1/premium', price: '0.10' },
      ],
      rails: mockFacilitatorRails(facilitator),
      payTo: VENDOR,
      network: 'base',
      asset: 'USDC',
    }),
    {
      serve: () =>
        new Response(JSON.stringify({ answer: 42 }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    },
  );
}, 120_000);

afterAll(async () => {
  await engine?.dispose();
});

const agentGuard = () =>
  createGuard({
    engineUrl: engine.url,
    apiKey: agentSecret,
    agentId,
    fetch: vendorFetch,
    payer: facilitator.payerFor(WALLET),
  });

describe('the deployable engine, driven the way an external agent drives it', () => {
  it('allow -> pay -> settle -> reconciled, on the agent key', async () => {
    const guard = agentGuard();
    const res = await guard.wrap()(CHEAP);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ answer: 42 });

    const receipt = guard.receipts().at(-1)!;
    expect(receipt.outcome).toBe('allow');
    expect(receipt.settlement?.txHash).toBeTruthy();
    expect(ledger.entries()).toHaveLength(1);

    // The guard reports its settlement after the response is already out, so
    // the engine's reconciliation closes a moment later -- and must close.
    const report = await until(
      () => guard.client.reconciliation({ window: '1h', graceMs: 0, agentId }),
      (r) => r.settled === 1 && r.unsettled === 0,
    );
    expect(report).toMatchObject({ allowed: 1, settled: 1, unsettled: 0, inFlight: 0 });
  });

  it('a payment over the cap is denied and never reaches the rails', async () => {
    const guard = agentGuard();
    await expect(guard.wrap()(DEAR)).rejects.toBeInstanceOf(PaymentBlockedError);
    expect(guard.receipts().at(-1)?.outcome).toBe('deny');
    expect(ledger.entries()).toHaveLength(1);
  });

  it('the agent key is narrower than the operator key', async () => {
    const asAgent = new EngineClient({ baseUrl: engine.url, apiKey: agentSecret });
    expect((await asAgent.listAgents()).some((a) => a.id === agentId)).toBe(true);
    const refused = await asAgent
      .addPolicy({
        policyId: newId('pol'),
        appliesTo: { agents: [agentId] },
        rules: [],
        default: 'allow',
      })
      .then(
        () => undefined,
        (err: unknown) => err,
      );
    expect(refused).toBeInstanceOf(EngineError);
    expect((refused as EngineError).status).toBe(403);
  });

  it('the MCP tool surface drives the same loop: rein_fetch, then rein_receipts', async () => {
    const tools = reinTools(
      createToolContext({
        engineUrl: engine.url,
        apiKey: agentSecret,
        agentId,
        payer: facilitator.payerFor(WALLET),
        fetch: vendorFetch as typeof globalThis.fetch,
      }),
    );
    const tool = (name: string) => tools.find((t) => t.name === name)!;

    const fetched = await tool('rein_fetch').handler({ url: CHEAP });
    expect(fetched.isError).toBeFalsy();
    const result = JSON.parse(fetched.content[0]!.text) as {
      status: number;
      rein_receipt?: { outcome: string; settled: boolean };
    };
    expect(result.status).toBe(200);
    expect(result.rein_receipt).toMatchObject({ outcome: 'allow', settled: true });
    expect(ledger.entries()).toHaveLength(2);

    const listed = await tool('rein_receipts').handler({ window: '1h' });
    expect(listed.isError).toBeFalsy();
    const view = JSON.parse(listed.content[0]!.text) as {
      sessionReceiptCount: number;
      reconciliation: { allowed: number; note?: string };
    };
    expect(view.sessionReceiptCount).toBe(1);
    expect(view.reconciliation.allowed).toBeGreaterThanOrEqual(2);
    // Settlements have been reported, so the "nobody reports" note stays off.
    expect(view.reconciliation.note).toBeUndefined();
  });

  it.skipIf(remote)(
    'survives a restart: the chain, the settlements and the issued key are all still there',
    async () => {
      const chain = (await admin.decisions()).length;
      expect(chain).toBeGreaterThanOrEqual(3);

      await engine.restart();

      expect((await admin.decisions()).length).toBe(chain);
      const report = await admin.reconciliation({ window: '1h', graceMs: 0, agentId });
      expect(report).toMatchObject({ settled: 2, unsettled: 0 });
      // D1(b): a key minted at runtime is state, and outlives the process.
      const asAgent = new EngineClient({ baseUrl: engine.url, apiKey: agentSecret });
      expect((await asAgent.listAgents()).some((a) => a.id === agentId)).toBe(true);
      // ...and the resumed engine still governs: the same cap, the same answer.
      await expect(agentGuard().wrap()(DEAR)).rejects.toBeInstanceOf(PaymentBlockedError);
      expect((await admin.decisions()).length).toBe(chain + 1);
    },
    120_000,
  );
});
