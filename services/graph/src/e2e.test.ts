import { describe, it, expect } from 'vitest';
import { newId } from '@rein/core';
import { PolicyEngine } from '@rein/policy-engine';
import { createGate, type GateRails } from '@rein/gate';
import { ReputationGraph, payerCheck } from './graph.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;

describe('end to end: the reputation loop closes on the engine', () => {
  it('observed history -> sync -> vendorReputationLt denies the sketchy vendor', async () => {
    const engine = new PolicyEngine();
    const graph = new ReputationGraph().observe(engine);
    const agent = await engine.registerAgent({
      id: newId('agt'),
      orgId: newId('org'),
      name: 'research-agent',
      wallets: [],
      status: 'active',
      createdAt: new Date(),
    });
    await engine.addPolicy({
      policyId: 'pol-reputation',
      version: '1',
      appliesTo: {},
      rules: [{ id: 'reputation-gate', deny: { vendorReputationLt: 40 } }],
      default: 'allow',
      denyFloor: '0.05',
    });

    const intentTo = (host: string, createdAt: Date) => ({
      agentId: agent.id,
      vendor: { host, address: '0xV' },
      resource: `https://${host}/api/answer`,
      amount: '0.05',
      asset: 'USDC' as const,
      chain: 'base' as const,
      createdAt,
    });

    // Day 0, no history anywhere: the policy must NOT fire on an unknown
    // vendor — no reputation data is indeterminate, not damning.
    const fresh = await engine.evaluateIntent(intentTo('sketchy-api.test', new Date()));
    expect(fresh.decision.outcome).toBe('allow');

    // Two weeks of history, observed straight off the engine bus. The good
    // vendor settles everything; the sketchy one rarely does, and picks up
    // chargebacks (manual disputes) on top.
    const start = Date.now() - 14 * DAY;
    for (let i = 0; i < 15; i += 1) {
      const at = new Date(start + i * HOUR);
      const good = await engine.evaluateIntent(intentTo('good-api.test', at));
      graph.ingest({
        type: 'payment.settled',
        at,
        payment: { intentId: good.intent.id, txHash: '0xtx', chain: 'base', blockNumber: 1n, confirmedAt: at },
      });
      const sketchy = await engine.evaluateIntent(intentTo('sketchy-api.test', at));
      if (i < 2) {
        graph.ingest({
          type: 'payment.settled',
          at,
          payment: { intentId: sketchy.intent.id, txHash: '0xtx', chain: 'base', blockNumber: 1n, confirmedAt: at },
        });
      }
    }
    for (let i = 0; i < 3; i += 1) {
      graph.report({ subject: { kind: 'vendor', id: 'sketchy-api.test' }, kind: 'dispute' });
    }

    // The loop: push confident vendor scores into the engine's spend store.
    const pushed = await graph.syncVendors(engine.spend);
    const hosts = Object.fromEntries(pushed.map((p) => [p.host, p.score]));
    expect(hosts['good-api.test']).toBeGreaterThan(65);
    expect(hosts['sketchy-api.test']).toBeLessThan(40);

    // Same agent, same policy, same amount — only the reputation differs.
    const denied = await engine.evaluateIntent(intentTo('sketchy-api.test', new Date()));
    expect(denied.decision.outcome).toBe('deny');
    expect(denied.decision.matchedRules).toContain('reputation-gate');
    const allowed = await engine.evaluateIntent(intentTo('good-api.test', new Date()));
    expect(allowed.decision.outcome).toBe('allow');
  });
});

describe('end to end: the reputation loop closes on the gate', () => {
  const VENDOR = '0xVendorTreasury';
  const URL = 'https://api.vendor.test/api/answer';

  const rails: GateRails = {
    async verify() {},
    async settle() {
      return { header: 'c2V0dGxlZA==', transaction: `0xtx${newId('grc')}`, network: 'base' };
    },
  };

  /** Flat mock-dialect X-PAYMENT header; `tag` varies the replay slot. */
  const header = (from: string, tag: string) =>
    Buffer.from(
      JSON.stringify({
        x402Version: 1,
        scheme: 'exact',
        network: 'base',
        payload: { from, to: VENDOR, value: '50000', asset: 'USDC', tag },
      }),
    ).toString('base64');

  it('replays at one gate get a wallet turned away at another', async () => {
    const graph = new ReputationGraph();
    // Two weeks ago, on some OTHER vendor's gate, a mule kept replaying the
    // same payment while a regular customer just paid.
    let t = Date.now() - 14 * DAY;
    const elsewhere = createGate({
      routes: [{ path: '/api/*', price: '0.05' }],
      rails,
      payTo: VENDOR,
      network: 'base',
      asset: 'USDC',
      now: () => new Date((t += HOUR / 4)),
    });
    graph.observe(elsewhere);

    const replayed = header('0xMuleWallet', 'replayed');
    for (let i = 0; i < 12; i += 1) {
      await elsewhere.handle({ method: 'GET', url: URL, payment: replayed });
      await elsewhere.handle({ method: 'GET', url: URL, payment: header('0xRegular', `r${i}`) });
    }

    // Today, OUR gate screens on the shared graph.
    const door = createGate({
      routes: [{ path: '/api/*', price: '0.05' }],
      rails,
      payTo: VENDOR,
      network: 'base',
      asset: 'USDC',
      screen: { check: payerCheck(graph) },
    });
    graph.observe(door);

    const refused = await door.handle({
      method: 'GET',
      url: URL,
      payment: header('0xMuleWallet', 'fresh-and-valid'),
    });
    if (refused.kind !== 'refused') throw new Error(`expected refused, got ${refused.kind}`);
    expect(refused.status).toBe(403);
    expect(refused.code).toBe('payer_denied');
    expect(refused.reason).toMatch(/below this gate's floor/);

    const served = await door.handle({
      method: 'GET',
      url: URL,
      payment: header('0xRegular', 'fresh'),
    });
    expect(served.kind).toBe('paid');

    // The newcomer rule still holds at the door: no history, no judgment.
    const newcomer = await door.handle({
      method: 'GET',
      url: URL,
      payment: header('0xBrandNew', 'first'),
    });
    expect(newcomer.kind).toBe('paid');
  });
});
