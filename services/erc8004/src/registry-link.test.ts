import { describe, expect, it } from 'vitest';
import { newId, type ReinEvent } from '@rein/core';
import { ReputationGraph } from '@rein/graph';
import { linkAgentFromRegistry, linkVendorFromRegistry } from './links.js';
import { MockIdentityRegistry } from './mock.js';

/**
 * Integration: registry facts drive graph.link — one on-chain identity, one
 * reputation. Fixtures mirror services/graph/src/graph.test.ts.
 */

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date('2026-07-02T12:00:00Z');
const HOST = 'api.vendor.test';
const TREASURY = '0xVendorTreasury';

const graphAt = () => new ReputationGraph({ now: () => NOW });
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

function engineHistory(
  graph: ReputationGraph,
  over: { agentId: string; n: number; settle: number },
): void {
  let t = daysAgo(14).getTime();
  for (let i = 0; i < over.n; i += 1) {
    t += HOUR;
    const at = new Date(t);
    const id = newId('int');
    graph.ingest({
      type: 'intent.created',
      at,
      intent: {
        id,
        agentId: over.agentId,
        vendor: { host: HOST, address: '0xV' },
        resource: `https://${HOST}/api/answer`,
        amount: '0.05',
        asset: 'USDC',
        chain: 'base',
        taskContext: {},
        nonce: newId('non'),
        createdAt: at,
      },
    });
    graph.ingest({
      type: 'decision.made',
      at,
      decision: {
        id: newId('dec'),
        intentId: id,
        intentHash: 'h'.repeat(64),
        outcome: 'allow',
        matchedRules: [],
        policyId: 'pol-test',
        policyVersion: '1',
        prevHash: 'GENESIS',
        hash: 'a'.repeat(64),
        signature: 'sig',
        latencyMs: 1,
        decidedAt: at,
      },
    });
    if (i < over.settle) {
      graph.ingest({
        type: 'payment.settled',
        at,
        payment: { intentId: id, txHash: '0xtx', chain: 'base', blockNumber: 1n, confirmedAt: at },
      });
    }
  }
}

function gateSettled(over: { payer: string; payTo?: string; at?: Date }): ReinEvent {
  const at = over.at ?? daysAgo(7);
  return {
    type: 'gate.settled',
    at,
    receipt: {
      id: newId('grc'),
      at,
      route: '/api/*',
      resource: '/api/answer',
      method: 'GET',
      payer: over.payer,
      payTo: over.payTo ?? TREASURY,
      amount: '0.05',
      amountAtomic: '50000',
      asset: 'USDC',
      network: 'base',
      transaction: '0xtx',
    },
  };
}

describe('linkAgentFromRegistry — on-chain facts fold the id spaces', () => {
  it('engine-side ULID and gate-side wallet merge into ONE erc8004-keyed row', async () => {
    const graph = graphAt();
    const registry = new MockIdentityRegistry();
    const ulid = newId('agt');
    const wallet = '0xAgentWallet01';

    engineHistory(graph, { agentId: ulid, n: 5, settle: 4 }); // ULID space
    graph.ingest(gateSettled({ payer: wallet })); // wallet space
    expect(graph.explain({ kind: 'agent', id: ulid })?.evidence.attempts).toBe(5);
    expect(graph.explain({ kind: 'agent', id: wallet })?.evidence.attempts).toBe(1);

    const { erc8004Id } = registry.register({ owner: wallet });
    const linked = await linkAgentFromRegistry(graph, registry, {
      id: ulid,
      erc8004Id,
      wallets: [{ address: wallet }],
    });

    expect(linked.source).toBe('erc8004');
    expect(linked.canonical).toEqual({ kind: 'agent', id: erc8004Id });
    const merged = graph.explain({ kind: 'agent', id: erc8004Id });
    expect(merged?.evidence.attempts).toBe(6); // 5 engine + 1 gate
    expect(merged?.evidence.settled).toBe(5);
    // Both old id spaces answer through the alias map.
    expect(graph.explain({ kind: 'agent', id: ulid })?.evidence.attempts).toBe(6);
    expect(graph.explain({ kind: 'agent', id: wallet })?.evidence.attempts).toBe(6);
  });

  it('two local agents claiming the SAME registration merge into one identity', async () => {
    const graph = graphAt();
    const registry = new MockIdentityRegistry();
    const [a, b] = [newId('agt'), newId('agt')];
    engineHistory(graph, { agentId: a, n: 3, settle: 2 });
    engineHistory(graph, { agentId: b, n: 4, settle: 3 });

    const { erc8004Id } = registry.register({ owner: '0xShared' });
    await linkAgentFromRegistry(graph, registry, { id: a, erc8004Id, wallets: [] });
    await linkAgentFromRegistry(graph, registry, { id: b, erc8004Id, wallets: [] });

    const merged = graph.explain({ kind: 'agent', id: erc8004Id });
    expect(merged?.evidence.attempts).toBe(7);
    expect(merged?.evidence.settled).toBe(5);
  });

  it('rotation continuity: setAgentWallet folds the new wallet into the same identity', async () => {
    const graph = graphAt();
    const registry = new MockIdentityRegistry();
    const ulid = newId('agt');
    const [w1, w2] = ['0xKey1', '0xKey2'];

    const { tokenId, erc8004Id } = registry.register({ owner: w1 });
    graph.ingest(gateSettled({ payer: w1 }));
    await linkAgentFromRegistry(graph, registry, { id: ulid, erc8004Id, wallets: [{ address: w1 }] });

    registry.setAgentWallet(tokenId, w2); // key rotation
    graph.ingest(gateSettled({ payer: w2 })); // evidence against the NEW key
    await linkAgentFromRegistry(graph, registry, {
      id: ulid,
      erc8004Id,
      wallets: [{ address: w2 }, { address: w1 }], // retired wallet stays on the doc (S16 rule)
    });

    const merged = graph.explain({ kind: 'agent', id: erc8004Id });
    expect(merged?.evidence.attempts).toBe(2); // both keys, one identity
    expect(graph.scores('agent')).toHaveLength(1);
  });

  it('an unregistered agent falls back to local ULID-canonical linking (today, byte-compatible)', async () => {
    const graph = graphAt();
    const registry = new MockIdentityRegistry();
    const ulid = newId('agt');
    const wallet = '0xLocalOnly';
    engineHistory(graph, { agentId: ulid, n: 2, settle: 1 });
    graph.ingest(gateSettled({ payer: wallet }));

    const linked = await linkAgentFromRegistry(graph, registry, {
      id: ulid,
      wallets: [{ address: wallet }],
    });

    expect(linked.source).toBe('local');
    expect(linked.canonical).toEqual({ kind: 'agent', id: ulid });
    expect(graph.explain({ kind: 'agent', id: ulid })?.evidence.attempts).toBe(3);
  });

  it('a stale doc (unknown tokenId) is lenient — local fallback, no throw', async () => {
    const graph = graphAt();
    const registry = new MockIdentityRegistry();
    const ulid = newId('agt');
    const staleId = registry.idOf(99n); // right registry, nonexistent agent

    const linked = await linkAgentFromRegistry(graph, registry, {
      id: ulid,
      erc8004Id: staleId,
      wallets: [{ address: '0xW' }],
    });

    expect(linked.source).toBe('local');
    expect(linked.canonical).toEqual({ kind: 'agent', id: ulid });
  });

  it('a NETWORK failure during resolution stays loud — no silent local fallback', async () => {
    const graph = graphAt();
    const registry = new MockIdentityRegistry();
    const { erc8004Id } = registry.register({ owner: '0xW' });
    // A reader whose chain is unreachable: rejects with a NON-Erc8004Error.
    const flaky = {
      ref: registry.ref,
      ownerOf: () => Promise.reject(new Error('ECONNREFUSED')),
      agentWallet: () => Promise.reject(new Error('ECONNREFUSED')),
      agentURI: () => Promise.reject(new Error('ECONNREFUSED')),
    };
    await expect(
      linkAgentFromRegistry(graph, flaky, { id: newId('agt'), erc8004Id, wallets: [] }),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('a CHECKSUMMED doc id normalizes: one lowercase canonical row, no split', async () => {
    const graph = graphAt();
    const registry = new MockIdentityRegistry({ address: '0x8004A818BFB912233c491871b3d84c89A494BD9e' });
    const wallet = '0xAgentWallet01';
    graph.ingest(gateSettled({ payer: wallet }));

    const { erc8004Id } = registry.register({ owner: wallet }); // idOf emits lowercase
    // The doc carries a CHECKSUMMED variant of the same identity.
    const checksummed = erc8004Id.replace(
      '0x8004a818bfb912233c491871b3d84c89a494bd9e',
      '0x8004A818BFB912233c491871b3d84c89A494BD9e',
    );
    const linked = await linkAgentFromRegistry(graph, registry, {
      id: newId('agt'),
      erc8004Id: checksummed,
      wallets: [{ address: wallet }],
    });

    expect(linked.source).toBe('erc8004');
    expect(linked.canonical.id).toBe(erc8004Id); // lowercase canonical, not the doc string
    expect(graph.scores('agent')).toHaveLength(1);
  });

  it('a FOREIGN registry reference is never resolved against ours', async () => {
    const graph = graphAt();
    const registry = new MockIdentityRegistry();
    registry.register({ owner: '0xSomebodyElse' }); // tokenId 1 exists HERE...
    const foreign = 'eip155:1:0x000000000000000000000000000000000000dead/1'; // ...but this names another registry

    const linked = await linkAgentFromRegistry(graph, registry, {
      id: newId('agt'),
      erc8004Id: foreign,
      wallets: [],
    });

    expect(linked.source).toBe('local'); // our registry cannot speak for that id
  });
});

describe('linkVendorFromRegistry — hosts stay the enforcement key', () => {
  it('treasury evidence folds into the host row and syncVendors pushes ONLY hosts', async () => {
    const graph = graphAt();
    const registry = new MockIdentityRegistry();
    const payer = '0xPayerWallet';

    // Engine-side vendor history (host-keyed) + gate-side revenue (payTo-keyed).
    engineHistory(graph, { agentId: newId('agt'), n: 15, settle: 14 });
    graph.ingest(gateSettled({ payer, payTo: TREASURY }));

    const { erc8004Id } = registry.register({ owner: TREASURY }); // vendor's on-chain identity
    const linked = await linkVendorFromRegistry(graph, registry, { host: HOST, erc8004Id });
    expect(linked.source).toBe('erc8004');

    const host = graph.explain({ kind: 'vendor', id: HOST });
    expect(host?.evidence.settled).toBe(15); // 14 engine + 1 gate, one row
    expect(graph.explain({ kind: 'vendor', id: TREASURY })?.evidence.settled).toBe(15); // via alias

    const pushed: string[] = [];
    await graph.syncVendors({ setVendorReputation: (h: string) => void pushed.push(h) });
    expect(pushed).toEqual([HOST]); // no eip155 string, no wallet leaks into engine keys
  });
});
