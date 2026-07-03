import { describe, it, expect, afterEach } from 'vitest';
import type { AddressInfo } from 'node:net';
import { newId, type Decision, type PaymentIntent } from '@reinconsole/core';
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { MockLedger } from './ledger.js';
import { MockFacilitator } from './facilitator.js';
import { MockIndexer } from './indexer.js';
import { createMockVendor } from './vendor.js';

const WALLET = '0xAgentWallet01';
const URL_ANSWER = 'https://api.vendor.test/v1/answer';

const closables: { close(): Promise<unknown> }[] = [];
afterEach(async () => {
  await Promise.all(closables.splice(0).map((c) => c.close()));
});

/**
 * One fully wired mock world per test: a real policy engine over HTTP, the
 * mock chain, a facilitator settling onto it, an indexer watching it, and a
 * paywalled vendor — the complete v0.1 loop.
 */
async function rig(atomicPrice = '10000') {
  const engine = new PolicyEngine();
  const app = buildServer(engine);
  await app.listen({ port: 0, host: '127.0.0.1' });
  const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  const ledger = new MockLedger();
  const facilitator = new MockFacilitator({ ledger, name: 'mock-facilitator' });
  const indexer = new MockIndexer({
    ledger,
    agents: () => engine.agents.list(),
    facilitator: facilitator.name,
  });
  indexer.connectEngine(engine);
  const vendor = createMockVendor({ facilitator, atomicPrice, payTo: '0xVENDOR' });

  closables.push(app);
  return { engine, engineUrl, ledger, facilitator, indexer, vendor };
}

type Rig = Awaited<ReturnType<typeof rig>>;

describe('mock rails end-to-end (engine + guard + facilitator + indexer)', () => {
  it('settles an allowed payment and reconciles it as payment.settled', async () => {
    const world = await rig();
    const agent = await registerAgent(world);
    const guard = createGuard({
      engineUrl: world.engineUrl,
      agentId: agent,
      fetch: world.vendor.fetch,
      payer: world.facilitator.payerFor(WALLET),
    });
    await guard.client.addPolicy({
      policyId: 'pol_allow',
      appliesTo: { agents: [agent] },
      rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
      default: 'allow',
    });

    const res = await guard.wrap()(URL_ANSWER);

    expect(res.status).toBe(200);
    const receipt = guard.receipts()[0];
    const entry = world.ledger.entries()[0];
    expect(entry).toMatchObject({ from: WALLET, to: '0xVENDOR', amount: '0.01', memo: receipt?.intentId });
    expect(receipt?.settlement?.txHash).toBe(entry?.txHash);

    expect(world.indexer.shadowSpends()).toHaveLength(0);
    expect(world.indexer.settledPayments()).toHaveLength(1);
    expect(world.indexer.settledPayments()[0]).toMatchObject({
      intentId: receipt?.intentId,
      txHash: entry?.txHash,
      blockNumber: 1n,
      facilitator: 'mock-facilitator',
    });
  });

  it('a denied payment leaves no trace on the chain', async () => {
    const world = await rig('2000000'); // 2.00 USDC, over the cap
    const agent = await registerAgent(world);
    const guard = createGuard({
      engineUrl: world.engineUrl,
      agentId: agent,
      fetch: world.vendor.fetch,
      payer: world.facilitator.payerFor(WALLET),
    });
    await guard.client.addPolicy({
      policyId: 'pol_cap',
      appliesTo: { agents: [agent] },
      rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
      default: 'allow',
    });

    await expect(guard.wrap()(URL_ANSWER)).rejects.toBeInstanceOf(PaymentBlockedError);

    expect(world.ledger.entries()).toHaveLength(0);
    expect(world.indexer.events()).toHaveLength(0);
  });

  it('flags a direct transfer that bypassed the guard as shadow.spend', async () => {
    const world = await rig();
    const agent = await registerAgent(world);

    // The agent pays a vendor straight on-chain — no guard, no decision.
    // (Uppercased from-address: EVM matching is case-insensitive.)
    const entry = world.ledger.transfer({
      chain: 'base',
      asset: 'USDC',
      from: WALLET.toUpperCase().replace('0X', '0x'),
      to: '0xDEALER',
      amount: '5',
    });

    expect(world.indexer.settledPayments()).toHaveLength(0);
    expect(world.indexer.shadowSpends()).toHaveLength(1);
    expect(world.indexer.shadowSpends()[0]).toMatchObject({
      agentId: agent,
      txHash: entry.txHash,
      chain: 'base',
      amount: '5',
    });
  });

  it('flags paying out a DENIED intent as shadow.spend, even though it settles', async () => {
    const world = await rig('2000000');
    const agent = await registerAgent(world);
    const guard = createGuard({
      engineUrl: world.engineUrl,
      agentId: agent,
      fetch: world.vendor.fetch,
      payer: world.facilitator.payerFor(WALLET),
    });
    await guard.client.addPolicy({
      policyId: 'pol_cap',
      appliesTo: { agents: [agent] },
      rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
      default: 'allow',
    });

    const blocked = await guard
      .wrap()(URL_ANSWER)
      .then(() => undefined)
      .catch((e: unknown) => e as PaymentBlockedError);
    expect(blocked).toBeInstanceOf(PaymentBlockedError);

    // A rogue agent pays anyway, going straight to the vendor — decision in
    // hand says DENY, and the mock payer doesn't check (that gap is what the
    // signer tier closes). The facilitator is not Rein-privileged, so the
    // payment SETTLES — but the indexer sees a memo with no ALLOW behind it.
    const header = await world.facilitator.payerFor(WALLET)(
      world.vendor.requirementFor(URL_ANSWER),
      blocked!.intent,
      blocked!.decision,
    );
    const res = await world.vendor.fetch(URL_ANSWER, { headers: { 'X-PAYMENT': header } });

    expect(res.status).toBe(200);
    expect(world.ledger.entries()).toHaveLength(1);
    expect(world.indexer.settledPayments()).toHaveLength(0);
    expect(world.indexer.shadowSpends()[0]).toMatchObject({ agentId: agent, amount: '2' });
  });

  it('ignores transfers from wallets Rein does not manage', async () => {
    const world = await rig();
    await registerAgent(world);

    world.ledger.transfer({
      chain: 'base',
      asset: 'USDC',
      from: '0xSTRANGER',
      to: '0xVENDOR',
      amount: '9.99',
    });

    expect(world.indexer.events()).toHaveLength(0);
  });

  it('reconciles a memo-less transfer against the allowed intent (advisory mode)', async () => {
    const world = await rig();
    const agent = await registerAgent(world);
    // Advisory guard: no payer, so the allow decision exists but nothing settles.
    const guard = createGuard({
      engineUrl: world.engineUrl,
      agentId: agent,
      fetch: world.vendor.fetch,
    });
    await guard.client.addPolicy({
      policyId: 'pol_allow',
      appliesTo: { agents: [agent] },
      default: 'allow',
    });

    const released = await guard.wrap()(URL_ANSWER);
    expect(released.status).toBe(402); // released to the payment layer above
    const intentId = guard.receipts()[0]?.intentId;

    // The payment layer settles on-chain without Rein's memo.
    world.ledger.transfer({
      chain: 'base',
      asset: 'USDC',
      from: WALLET,
      to: '0xVENDOR',
      amount: '0.01',
    });

    expect(world.indexer.shadowSpends()).toHaveLength(0);
    expect(world.indexer.settledPayments()[0]).toMatchObject({ intentId });
  });

  it('flags a replayed settlement memo as shadow.spend', async () => {
    const world = await rig();
    const agent = await registerAgent(world);
    const intents: PaymentIntent[] = [];
    const decisions: Decision[] = [];
    world.engine.onEvent((e) => {
      if (e.type === 'intent.created') intents.push(e.intent);
      if (e.type === 'decision.made') decisions.push(e.decision);
    });
    const guard = createGuard({
      engineUrl: world.engineUrl,
      agentId: agent,
      fetch: world.vendor.fetch,
      payer: world.facilitator.payerFor(WALLET),
    });
    await guard.client.addPolicy({
      policyId: 'pol_allow',
      appliesTo: { agents: [agent] },
      default: 'allow',
    });

    const first = await guard.wrap()(URL_ANSWER);
    expect(first.status).toBe(200);
    expect(world.indexer.settledPayments()).toHaveLength(1);

    // Replay the same allowed intent a second time.
    const replay = await world.facilitator.payerFor(WALLET)(
      world.vendor.requirementFor(URL_ANSWER),
      intents[0]!,
      decisions[0]!,
    );
    await world.vendor.fetch(URL_ANSWER, { headers: { 'X-PAYMENT': replay } });

    expect(world.indexer.settledPayments()).toHaveLength(1); // still just one
    expect(world.indexer.shadowSpends()).toHaveLength(1);
  });
});

/** Register a fresh agent whose base wallet is managed in sdk mode. */
async function registerAgent(world: Rig): Promise<string> {
  const agent = await world.engine.registerAgent({
    id: newId('agt'),
    orgId: newId('org'),
    name: 'rails-test-agent',
    wallets: [{ chain: 'base', address: WALLET, mode: 'sdk' }],
    status: 'active',
    createdAt: new Date(),
  });
  return agent.id;
}
