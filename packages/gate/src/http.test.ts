import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { newId } from '@rein/core';
import { PolicyEngine, buildServer } from '@rein/policy-engine';
import { MockFacilitator, MockIndexer, MockLedger } from '@rein/mock-rails';
import { createGuard, PaymentRequired } from '@rein/sdk';
import { createGate, type Gate, type GateOptions } from './gate.js';
import { gateMiddleware } from './node.js';
import { mockFacilitatorRails } from './rails.js';

const VENDOR = '0xVENDOR';
const WALLET = '0xAgentWallet01';

const closables: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(closables.splice(0).map((c) => c.close()));
});

/** A real HTTP vendor: gate middleware in front of a plain Node handler. */
async function startVendor(gate: Gate) {
  const paywall = gateMiddleware(gate);
  const server = http.createServer((req, res) => {
    paywall(req, res, () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ report: 'alpha' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  closables.push({ close: () => new Promise((resolve) => server.close(resolve)) });
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * The complete two-sided world: a policy engine over HTTP governing the agent,
 * mock rails as the chain, and a gate-protected vendor over HTTP earning from
 * it. Rein on both sides of the wire.
 */
async function rig(gateOverrides: Partial<GateOptions> = {}) {
  const engine = new PolicyEngine();
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  closables.push(app);
  const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const ledger = new MockLedger();
  const facilitator = new MockFacilitator({ ledger });
  const indexer = new MockIndexer({
    ledger,
    agents: () => engine.agents.list(),
    facilitator: facilitator.name,
  });
  indexer.connectEngine(engine);

  const gate = createGate({
    routes: [{ path: '/api/answer', price: '0.05', description: 'one answer' }],
    rails: mockFacilitatorRails(facilitator),
    payTo: VENDOR,
    network: 'base',
    asset: 'USDC',
    ...gateOverrides,
  });
  const vendorUrl = await startVendor(gate);

  const agent = engine.registerAgent({
    id: newId('agt'),
    orgId: newId('org'),
    name: 'gate-test-agent',
    wallets: [{ chain: 'base', address: WALLET, mode: 'sdk' }],
    status: 'active',
    createdAt: new Date(),
  });
  const guard = createGuard({
    engineUrl,
    agentId: agent.id,
    payer: facilitator.payerFor(WALLET),
    fetch: (input, init) => globalThis.fetch(input, init),
  });
  await guard.client.addPolicy({
    policyId: 'pol_allow',
    appliesTo: { agents: [agent.id] },
    rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
    default: 'allow',
  });

  return { engine, ledger, indexer, gate, vendorUrl, guard };
}

describe('gateMiddleware over real HTTP', () => {
  it('serves unpriced routes for free', async () => {
    const world = await rig();
    const res = await fetch(`${world.vendorUrl}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: 'alpha' });
    expect(world.gate.stats().quoted).toBe(0);
  });

  it('quotes a 402 with the absolute resource URL', async () => {
    const world = await rig();
    const res = await fetch(`${world.vendorUrl}/api/answer`);
    expect(res.status).toBe(402);
    const body = PaymentRequired.parse(await res.json());
    expect(body.accepts[0]).toMatchObject({
      maxAmountRequired: '50000',
      payTo: VENDOR,
      resource: `${world.vendorUrl}/api/answer`,
    });
  });

  it('a Rein-guarded agent pays a Rein-gated vendor: both sides get receipts', async () => {
    const world = await rig();

    const res = await world.guard.wrap()(`${world.vendorUrl}/api/answer`);

    // The agent got the content and a settlement proof.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ report: 'alpha' });
    expect(res.headers.get('x-payment-response')).toBeTruthy();

    // Agent side: a guard receipt with the settlement tx.
    const agentReceipt = world.guard.receipts()[0];
    expect(agentReceipt?.settlement?.txHash).toBeTruthy();

    // Vendor side: a gate receipt for the same settlement.
    const gateReceipt = world.gate.receipts[0];
    expect(gateReceipt).toMatchObject({
      route: '/api/answer',
      payer: WALLET,
      amount: '0.05',
      transaction: agentReceipt?.settlement?.txHash,
    });

    // Chain side: one ledger entry, memo = the intent id, indexer reconciled.
    expect(world.ledger.entries()[0]?.memo).toBe(agentReceipt?.intentId);
    expect(world.indexer.settledPayments()).toHaveLength(1);
    expect(world.indexer.shadowSpends()).toHaveLength(0);
  });

  it('refuses a blocked payer with 403 before any settlement', async () => {
    const world = await rig({ screen: { denyPayers: [WALLET] } });
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: { from: WALLET, to: VENDOR, value: '50000', asset: 'USDC' },
      }),
    ).toString('base64');

    const res = await fetch(`${world.vendorUrl}/api/answer`, {
      headers: { 'X-PAYMENT': header },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'refused', code: 'payer_denied' });
    expect(world.ledger.entries()).toHaveLength(0);
  });

  it('answers 500 on unexpected rails failures and keeps serving', async () => {
    const gate = createGate({
      routes: [{ path: '/api/answer', price: '0.05' }],
      rails: {
        async verify() {
          throw new TypeError('rails exploded');
        },
        async settle() {
          throw new TypeError('unreachable');
        },
      },
      payTo: VENDOR,
      network: 'base',
      asset: 'USDC',
    });
    const vendorUrl = await startVendor(gate);
    const header = Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: { from: WALLET, to: VENDOR, value: '50000', asset: 'USDC' },
      }),
    ).toString('base64');

    const broken = await fetch(`${vendorUrl}/api/answer`, { headers: { 'X-PAYMENT': header } });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ error: 'internal_error' });

    // The vendor server survived: the next request still quotes normally.
    const next = await fetch(`${vendorUrl}/api/answer`);
    expect(next.status).toBe(402);
  });
});
