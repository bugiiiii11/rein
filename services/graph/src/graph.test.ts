import { EventEmitter } from 'node:events';
import { describe, it, expect } from 'vitest';
import { newId, type Receipt, type ReinEvent } from '@rein/core';
import { EvidenceLedger, subjectKey } from './evidence.js';
import { ReputationGraph, payerCheck } from './graph.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = new Date('2026-06-11T12:00:00Z');
const HOST = 'api.vendor.test';
const AGENT = newId('agt');
const WALLET = '0xAgentWallet01';
const PAY_TO = '0xVendorTreasury';

const graphAt = (now = NOW) => new ReputationGraph({ now: () => now });
const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

function intentCreated(over: {
  id?: string;
  agentId?: string;
  host?: string;
  amount?: string;
  at?: Date;
}): ReinEvent {
  const at = over.at ?? NOW;
  return {
    type: 'intent.created',
    at,
    intent: {
      id: over.id ?? newId('int'),
      agentId: over.agentId ?? AGENT,
      vendor: { host: over.host ?? HOST, address: '0xV' },
      resource: `https://${over.host ?? HOST}/api/answer`,
      amount: over.amount ?? '0.05',
      asset: 'USDC',
      chain: 'base',
      taskContext: {},
      nonce: newId('non'),
      createdAt: at,
    },
  };
}

function decisionMade(over: {
  intentId: string;
  outcome?: 'allow' | 'deny' | 'escalate';
  at?: Date;
}): ReinEvent {
  const at = over.at ?? NOW;
  return {
    type: 'decision.made',
    at,
    decision: {
      id: newId('dec'),
      intentId: over.intentId,
      intentHash: 'h'.repeat(64),
      outcome: over.outcome ?? 'allow',
      matchedRules: [],
      policyId: 'pol-test',
      policyVersion: '1',
      prevHash: 'GENESIS',
      hash: 'a'.repeat(64),
      signature: 'sig',
      latencyMs: 1,
      decidedAt: at,
    },
  };
}

function paymentSettled(over: { intentId: string; at?: Date }): ReinEvent {
  const at = over.at ?? NOW;
  return {
    type: 'payment.settled',
    at,
    payment: {
      intentId: over.intentId,
      txHash: '0xtx',
      chain: 'base',
      blockNumber: 1n,
      confirmedAt: at,
    },
  };
}

function gateSettled(over: { payer?: string; payTo?: string; amount?: string; at?: Date }): ReinEvent {
  const at = over.at ?? NOW;
  return {
    type: 'gate.settled',
    at,
    receipt: {
      id: newId('grc'),
      at,
      route: '/api/*',
      resource: '/api/answer',
      method: 'GET',
      payer: over.payer ?? WALLET,
      payTo: over.payTo ?? PAY_TO,
      amount: over.amount ?? '0.05',
      amountAtomic: '50000',
      asset: 'USDC',
      network: 'base',
      transaction: '0xtx',
    },
  };
}

function gateRefused(over: { payer?: string; code?: string; at?: Date }): ReinEvent {
  return {
    type: 'gate.refused',
    at: over.at ?? NOW,
    code: over.code ?? 'payment_replayed',
    reason: 'refused',
    resource: '/api/answer',
    payer: over.payer,
  };
}

/** Drive n engine-side purchases (intent -> allow -> maybe settle), pacing hourly. */
function history(
  graph: ReputationGraph,
  over: { host?: string; agentId?: string; n: number; settle: number; startDaysAgo?: number },
): void {
  let t = daysAgo(over.startDaysAgo ?? 14).getTime();
  for (let i = 0; i < over.n; i += 1) {
    t += HOUR;
    const at = new Date(t);
    const id = newId('int');
    graph.ingest(intentCreated({ id, host: over.host, agentId: over.agentId, at }));
    graph.ingest(decisionMade({ intentId: id, at }));
    if (i < over.settle) graph.ingest(paymentSettled({ intentId: id, at }));
  }
}

describe('ReputationGraph.ingest — engine-side events', () => {
  it('an allowed decision counts one attempt on the agent AND the vendor (by host)', () => {
    const graph = graphAt();
    const id = newId('int');
    graph.ingest(intentCreated({ id }));
    graph.ingest(decisionMade({ intentId: id }));
    expect(graph.explain({ kind: 'vendor', id: HOST })?.evidence.attempts).toBe(1);
    expect(graph.explain({ kind: 'agent', id: AGENT })?.evidence.attempts).toBe(1);
    expect(graph.explain({ kind: 'vendor', id: HOST })?.evidence.settled).toBe(0);
  });

  it('denied and escalated decisions count NOTHING — a deny means policy worked', () => {
    const graph = graphAt();
    for (const outcome of ['deny', 'escalate'] as const) {
      const id = newId('int');
      graph.ingest(intentCreated({ id }));
      graph.ingest(decisionMade({ intentId: id, outcome }));
    }
    expect(graph.score({ kind: 'vendor', id: HOST })).toBeUndefined();
    expect(graph.score({ kind: 'agent', id: AGENT })).toBeUndefined();
  });

  it('a settlement credits both sides, sums volume, and draws the edge', () => {
    const graph = graphAt();
    const id = newId('int');
    graph.ingest(intentCreated({ id, amount: '0.25' }));
    graph.ingest(decisionMade({ intentId: id }));
    graph.ingest(paymentSettled({ intentId: id }));

    const vendor = graph.explain({ kind: 'vendor', id: HOST })!;
    expect(vendor.evidence).toMatchObject({ attempts: 1, settled: 1, volume: '0.25' });
    expect(vendor.evidence.counterparties).toEqual([
      { subject: { kind: 'agent', id: AGENT }, settled: 1, volume: '0.25' },
    ]);
    const agent = graph.explain({ kind: 'agent', id: AGENT })!;
    expect(agent.evidence.counterparties[0]?.subject).toEqual({ kind: 'vendor', id: HOST });
  });

  it('an unattributable settlement (unknown intent) is ignored, not guessed at', () => {
    const graph = graphAt();
    graph.ingest(paymentSettled({ intentId: newId('int') }));
    expect(graph.subjects()).toBe(0);
  });

  it('hosts are case-insensitive subjects', () => {
    const graph = graphAt();
    const id = newId('int');
    graph.ingest(intentCreated({ id, host: 'API.Vendor.Test' }));
    graph.ingest(decisionMade({ intentId: id }));
    expect(graph.score({ kind: 'vendor', id: 'api.vendor.test' })).toBeDefined();
  });

  it('erc8004 ids canonicalize regardless of hand-built casing or zero-padding', () => {
    const canonical = 'eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e/42';
    for (const variant of [
      'eip155:84532:0x8004A818BFB912233c491871b3d84c89A494BD9e/42', // checksummed
      'eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e/042', // zero-padded tokenId
    ]) {
      expect(subjectKey({ kind: 'agent', id: variant })).toBe(`agent:${canonical}`);
      expect(subjectKey({ kind: 'vendor', id: variant })).toBe(`vendor:${canonical}`);
    }
    // Malformed eip155-ish strings fall through to the plain rules (no throw).
    expect(subjectKey({ kind: 'agent', id: 'eip155:junk' })).toBe('agent:eip155:junk');
  });

  it('shadow spends and signature refusals land on the agent', () => {
    const graph = graphAt();
    graph.ingest({
      type: 'shadow.spend',
      at: NOW,
      agentId: AGENT,
      txHash: '0xrogue',
      chain: 'base',
      amount: '2.50',
    });
    graph.ingest({
      type: 'signature.refused',
      at: NOW,
      code: 'decision_replayed',
      reason: 'replay',
      agentId: AGENT,
    });
    const agent = graph.explain({ kind: 'agent', id: AGENT })!;
    expect(agent.evidence.shadowSpends).toBe(1);
    expect(agent.evidence.refusals).toEqual({ decision_replayed: 1 });
  });

  it('a signature refusal naming no agent is dropped', () => {
    const graph = graphAt();
    graph.ingest({ type: 'signature.refused', at: NOW, code: 'session_unknown', reason: 'x' });
    expect(graph.subjects()).toBe(0);
  });

  it('evicts the oldest correlation entry beyond the limit', () => {
    const graph = new ReputationGraph({ now: () => NOW, correlationLimit: 2 });
    const first = newId('int');
    graph.ingest(intentCreated({ id: first }));
    graph.ingest(intentCreated({ id: newId('int') }));
    graph.ingest(intentCreated({ id: newId('int') })); // evicts `first`
    graph.ingest(paymentSettled({ intentId: first }));
    expect(graph.subjects()).toBe(0);
  });
});

describe('ReputationGraph.ingest — gate-side events', () => {
  it('a gate settlement credits the payer wallet (lowercased) and the payTo recipient', () => {
    const graph = graphAt();
    graph.ingest(gateSettled({}));
    const payer = graph.explain({ kind: 'agent', id: WALLET.toLowerCase() })!;
    expect(payer.evidence).toMatchObject({ attempts: 1, settled: 1, volume: '0.05' });
    const recipient = graph.explain({ kind: 'vendor', id: PAY_TO.toLowerCase() })!;
    expect(recipient.evidence).toMatchObject({ attempts: 1, settled: 1 });
  });

  it('a gate refusal counts an attempt plus the refusal code against the payer', () => {
    const graph = graphAt();
    graph.ingest(gateRefused({ payer: WALLET }));
    const payer = graph.explain({ kind: 'agent', id: WALLET })!;
    expect(payer.evidence.attempts).toBe(1);
    expect(payer.evidence.refusals).toEqual({ payment_replayed: 1 });
  });

  it('a refusal with no decodable payer is dropped', () => {
    const graph = graphAt();
    graph.ingest(gateRefused({ code: 'malformed_payment' }));
    expect(graph.subjects()).toBe(0);
  });

  it('a synchronously-throwing ledger cannot crash ingest (fire takes a thunk)', () => {
    // Parity with the gate's fire() (S19): telemetry failures surface via
    // flush(), never as an exception out of a bus handler.
    const ledger = new EvidenceLedger();
    const throwing = new Proxy(ledger, {
      get(target, prop, receiver) {
        if (prop === 'recordAttempt') {
          return () => {
            throw new Error('sync ledger explosion');
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const graph = new ReputationGraph({ now: () => NOW, ledger: throwing });
    expect(() => graph.ingest(gateSettled({}))).not.toThrow();
  });

  it('no-fault refusals (throttle + rails codes) carry NO evidence — not even the attempt', () => {
    // One gate's rate limit must not bleed into a payer's GLOBAL score, and a
    // settle_unknown payment may even have gone through — the gate-side
    // parallel of "denied decisions count against no one".
    const graph = graphAt();
    for (const code of ['rate_limited', 'velocity_exceeded', 'rails_unavailable', 'settle_unknown']) {
      graph.ingest(gateRefused({ payer: WALLET, code }));
    }
    expect(graph.subjects()).toBe(0);
    expect(graph.explain({ kind: 'agent', id: WALLET })).toBeUndefined();
  });
});

describe('ReputationGraph — receipts, reports, scores', () => {
  function receipt(over: Partial<Receipt> = {}): Receipt {
    return {
      id: newId('rcp'),
      agentId: AGENT,
      intentId: newId('int'),
      decisionId: newId('dec'),
      outcome: 'allow',
      url: `https://${HOST}/api/answer`,
      method: 'GET',
      vendorHost: HOST,
      amount: '0.05',
      asset: 'USDC',
      chain: 'base',
      taskContext: {},
      settlement: { txHash: '0xtx' },
      createdAt: NOW,
      ...over,
    };
  }

  it('ingestReceipt mirrors the bus mapping: allow+settlement credits, deny is ignored', () => {
    const graph = graphAt();
    graph.ingestReceipt(receipt());
    graph.ingestReceipt(receipt({ settlement: undefined })); // attempted, never settled
    graph.ingestReceipt(receipt({ outcome: 'deny' }));
    const vendor = graph.explain({ kind: 'vendor', id: HOST })!;
    expect(vendor.evidence).toMatchObject({ attempts: 2, settled: 1 });
  });

  it('manual disputes and endorsements move the dispute component', () => {
    const graph = graphAt();
    history(graph, { n: 10, settle: 10 });
    const clean = graph.score({ kind: 'vendor', id: HOST })!;
    graph.report({ subject: { kind: 'vendor', id: HOST }, kind: 'dispute', at: NOW });
    const disputed = graph.score({ kind: 'vendor', id: HOST })!;
    expect(disputed.components.disputeRate).toBeLessThan(clean.components.disputeRate);
    expect(disputed.score).toBeLessThan(clean.score);
    graph.report({ subject: { kind: 'vendor', id: HOST }, kind: 'endorsement', at: NOW });
    expect(graph.score({ kind: 'vendor', id: HOST })!.score).toBeGreaterThanOrEqual(
      disputed.score,
    );
  });

  it('score() is undefined for a subject with no evidence — unknown stays unknown', () => {
    expect(graphAt().score({ kind: 'vendor', id: 'never-seen.test' })).toBeUndefined();
  });

  it('scores(kind) filters by kind and sorts best first', () => {
    const graph = graphAt();
    history(graph, { host: 'good.test', n: 18, settle: 18 });
    history(graph, { host: 'flaky.test', n: 12, settle: 2 });
    const vendors = graph.scores('vendor');
    expect(vendors.map((s) => s.subject.id)).toEqual(['good.test', 'flaky.test']);
    expect(vendors[0]!.score).toBeGreaterThan(vendors[1]!.score);
    expect(graph.scores('agent').every((s) => s.subject.kind === 'agent')).toBe(true);
  });

  it('a reliable two-week vendor scores high; a failing one scores low', () => {
    const graph = graphAt();
    history(graph, { host: 'good.test', n: 18, settle: 18 });
    history(graph, { host: 'flaky.test', n: 12, settle: 2 });
    const good = graph.score({ kind: 'vendor', id: 'good.test' })!;
    const flaky = graph.score({ kind: 'vendor', id: 'flaky.test' })!;
    expect(good.score).toBeGreaterThan(65);
    // Failing to settle dings reliability but keeps a clean dispute record —
    // a flaky vendor drifts down; only misconduct (disputes etc.) craters it.
    expect(flaky.score).toBeLessThan(60);
    expect(good.confidence).toBeGreaterThan(0.5);
  });

  it('counterparty quality flows one hop: who you settle with marks you', () => {
    const graph = graphAt();
    // Two recipients with identical direct evidence, different crowds.
    let t = daysAgo(14).getTime();
    for (let i = 0; i < 10; i += 1) {
      t += HOUR;
      graph.ingest(gateSettled({ payer: '0xCleanWallet', payTo: '0xPopularVendor', at: new Date(t) }));
      graph.ingest(gateSettled({ payer: '0xMuleWallet', payTo: '0xMulesVendor', at: new Date(t) }));
    }
    // The mule also replays payments all over town.
    for (let i = 0; i < 10; i += 1) {
      t += HOUR;
      graph.ingest(gateRefused({ payer: '0xMuleWallet', at: new Date(t) }));
    }
    const popular = graph.score({ kind: 'vendor', id: '0xpopularvendor' })!;
    const mules = graph.score({ kind: 'vendor', id: '0xmulesvendor' })!;
    expect(popular.components.settlementReliability).toBe(mules.components.settlementReliability);
    expect(mules.components.counterpartyQuality).toBeLessThan(
      popular.components.counterpartyQuality,
    );
    expect(mules.score).toBeLessThan(popular.score);
  });

  it('observe() subscribes to any onEvent bus', () => {
    const bus = new EventEmitter();
    const graph = graphAt().observe({ onEvent: (h) => bus.on('event', h) });
    bus.emit('event', gateSettled({}));
    expect(graph.subjects()).toBe(2);
  });
});

describe('syncVendors — the loop back into the engine', () => {
  it('pushes confident vendor scores and withholds thin histories', async () => {
    const graph = graphAt();
    history(graph, { host: 'good.test', n: 18, settle: 18 });
    // One same-day sighting: real evidence, zero track record.
    const id = newId('int');
    graph.ingest(intentCreated({ id, host: 'newcomer.test', at: NOW }));
    graph.ingest(decisionMade({ intentId: id, at: NOW }));

    const pushed: Record<string, number> = {};
    const result = await graph.syncVendors({
      setVendorReputation: (host, score) => {
        pushed[host] = score;
      },
    });

    expect(Object.keys(pushed)).toEqual(['good.test']);
    expect(result).toEqual([
      { host: 'good.test', score: expect.any(Number), confidence: expect.any(Number) },
    ]);
    expect(result[0]!.confidence).toBeGreaterThanOrEqual(0.3);
  });

  it('never pushes agents, and respects a custom confidence floor', async () => {
    const graph = graphAt();
    history(graph, { host: 'good.test', n: 18, settle: 18 });
    expect(await graph.syncVendors({ setVendorReputation: () => {} }, { minConfidence: 0.99 }))
      .toEqual([]);
    const hosts: string[] = [];
    await graph.syncVendors({ setVendorReputation: (host) => void hosts.push(host) });
    expect(hosts).toEqual(['good.test']); // the agent subject driven by history() stays out
  });
});

describe('payerCheck — the loop back into the gate', () => {
  it('passes unknown wallets and thin histories (fairness), refuses confident rogues', () => {
    const graph = graphAt();
    let t = daysAgo(14).getTime();
    for (let i = 0; i < 12; i += 1) {
      t += HOUR;
      graph.ingest(gateRefused({ payer: '0xMule', at: new Date(t) }));
      graph.ingest(gateSettled({ payer: '0xRegular', at: new Date(t) }));
    }
    graph.ingest(gateSettled({ payer: '0xNewcomer', at: NOW }));

    const check = payerCheck(graph);
    expect(check('0xNeverSeen')).toBeUndefined();
    expect(check('0xNewcomer')).toBeUndefined();
    expect(check('0xRegular')).toBeUndefined();
    expect(check('0xMule')).toMatch(/below this gate's floor/);
    expect(check('0xMULE')).toBeDefined(); // EVM case-insensitivity
  });

  it('honors custom thresholds', () => {
    const graph = graphAt();
    graph.ingest(gateRefused({ payer: '0xMule', at: NOW }));
    expect(payerCheck(graph)('0xMule')).toBeUndefined(); // thin history
    expect(payerCheck(graph, { minConfidence: 0, denyBelow: 100 })('0xMule')).toBeDefined();
  });
});

describe('link — identity merging across id spaces (the ERC-8004 story)', () => {
  const ULID = { kind: 'agent', id: AGENT } as const;
  const WALLET_SUBJECT = { kind: 'agent', id: WALLET } as const;

  it('linking after the fact folds the alias history into the canonical subject', () => {
    const graph = graphAt();
    history(graph, { n: 10, settle: 8 }); // engine-side: AGENT (ULID) x HOST
    graph.ingest(gateSettled({ at: daysAgo(2) })); // gate-side: WALLET x PAY_TO
    const engineSide = graph.explain(ULID)!.evidence;
    const walletSide = graph.explain(WALLET_SUBJECT)!.evidence;

    graph.link(ULID, WALLET_SUBJECT);

    // One subject remains; the alias resolves to it on every read.
    expect(graph.scores('agent')).toHaveLength(1);
    const merged = graph.explain(WALLET_SUBJECT)!;
    expect(merged.score.subject.id).toBe(AGENT);
    expect(merged.evidence.attempts).toBe(engineSide.attempts + walletSide.attempts);
    expect(merged.evidence.settled).toBe(engineSide.settled + walletSide.settled);
    expect(Number(merged.evidence.volume)).toBeCloseTo(
      Number(engineSide.volume) + Number(walletSide.volume),
      10,
    );
    // The settled-money edges re-keyed on BOTH ends: the payTo vendor now
    // counts the ULID as its counterparty, not the vanished wallet.
    const payTo = graph.explain({ kind: 'vendor', id: PAY_TO })!.evidence;
    expect(payTo.counterparties.map((c) => c.subject.id)).toContain(AGENT);
    expect(payTo.counterparties.map((c) => c.subject.id)).not.toContain(WALLET.toLowerCase());
  });

  it('linking up front redirects all future evidence — the alias never becomes a subject', () => {
    const graph = graphAt();
    graph.link(ULID, WALLET_SUBJECT);
    graph.ingest(gateSettled({ at: daysAgo(1) }));
    expect(graph.explain(ULID)!.evidence.settled).toBe(1);
    expect(graph.scores('agent')).toHaveLength(1);
    expect(graph.score(WALLET_SUBJECT)!.subject.id).toBe(AGENT);
  });

  it('payerCheck sees engine-side sins through the linked wallet', () => {
    const graph = graphAt();
    // The agent misbehaved on the ENGINE side only: a dozen shadow spends.
    let t = daysAgo(10).getTime();
    for (let i = 0; i < 12; i += 1) {
      t += HOUR;
      graph.ingest({
        type: 'shadow.spend',
        at: new Date(t),
        agentId: AGENT,
        txHash: `0xshadow${i}`,
        chain: 'base',
        amount: '1.00',
      });
    }
    const check = payerCheck(graph);
    // Unlinked, the wallet is a stranger at the door.
    expect(check(WALLET)).toBeUndefined();
    graph.link(ULID, WALLET_SUBJECT);
    // Linked, the wallet answers for its agent.
    expect(check(WALLET)).toMatch(/below this gate's floor/);
  });

  it('a vendor payTo address folds into the host-keyed vendor, and only the host syncs', async () => {
    const graph = graphAt();
    history(graph, { n: 8, settle: 8 }); // host-keyed vendor evidence
    graph.ingest(gateSettled({ at: daysAgo(3) })); // payTo-keyed vendor evidence
    graph.link({ kind: 'vendor', id: HOST }, { kind: 'vendor', id: PAY_TO });
    expect(graph.scores('vendor')).toHaveLength(1);
    const pushed: string[] = [];
    await graph.syncVendors({ setVendorReputation: (host) => void pushed.push(host) });
    expect(pushed).toEqual([HOST]);
  });

  it('re-asserting a known link is a no-op (boot-time link derivation is free)', () => {
    const graph = graphAt();
    history(graph, { n: 6, settle: 6 });
    graph.ingest(gateSettled({ at: daysAgo(2) }));
    graph.link(ULID, WALLET_SUBJECT);
    const once = graph.explain(ULID)!.evidence;
    graph.link(ULID, WALLET_SUBJECT);
    expect(graph.explain(ULID)!.evidence).toEqual(once);
  });

  it('alias chains flatten: linking through an alias lands on the true canonical', () => {
    const graph = graphAt();
    graph.link(ULID, WALLET_SUBJECT);
    // A second wallet linked to the FIRST wallet still resolves to the ULID.
    graph.link(WALLET_SUBJECT, { kind: 'agent', id: '0xSecondWallet' });
    graph.ingest(gateSettled({ payer: '0xSecondWallet', at: daysAgo(1) }));
    expect(graph.explain(ULID)!.evidence.settled).toBe(1);
    expect(graph.scores('agent')).toHaveLength(1);
  });
});
