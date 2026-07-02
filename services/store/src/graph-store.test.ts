import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { newId, type ReinEvent } from '@rein/core';
import { ReputationGraph } from '@rein/graph';
import type { PGlite } from '@electric-sql/pglite';
import { openDb } from './db.js';
import { PgIntentStore } from './graph-stores.js';
import { openReinStore, type ReinStore } from './index.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
// Scores are functions of evidence AND time — every graph in this file gets
// this exact clock, so pre- and post-restart scores must agree to the byte.
const NOW = new Date('2026-07-02T12:00:00Z');
const GOOD_HOST = 'good-feeds.test';
const SHADY_HOST = 'shady-data.test';
const AGENT = newId('agt');
const WALLET = '0xAgentWallet01';
const PAY_TO = '0xVendorTreasury';

const daysAgo = (d: number) => new Date(NOW.getTime() - d * DAY);

function graphOn(store: ReinStore): ReputationGraph {
  return new ReputationGraph({ ledger: store.ledger, intents: store.intents, now: () => NOW });
}

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
      vendor: { host: over.host ?? GOOD_HOST, address: '0xV' },
      resource: `https://${over.host ?? GOOD_HOST}/api/answer`,
      amount: over.amount ?? '0.05',
      asset: 'USDC',
      chain: 'base',
      taskContext: {},
      nonce: newId('non'),
      createdAt: at,
    },
  };
}

function decisionMade(over: { intentId: string; at?: Date }): ReinEvent {
  const at = over.at ?? NOW;
  return {
    type: 'decision.made',
    at,
    decision: {
      id: newId('dec'),
      intentId: over.intentId,
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

function gateSettled(over: { payer?: string; amount?: string; at?: Date }): ReinEvent {
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
      payTo: PAY_TO,
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
    payer: over.payer ?? WALLET,
  };
}

/** Drive n engine-side purchases (intent -> allow -> maybe settle), pacing hourly. */
function history(
  graph: ReputationGraph,
  over: { host: string; n: number; settle: number; startDaysAgo?: number },
): void {
  let t = daysAgo(over.startDaysAgo ?? 14).getTime();
  for (let i = 0; i < over.n; i += 1) {
    t += HOUR;
    const at = new Date(t);
    const id = newId('int');
    graph.ingest(intentCreated({ id, host: over.host, at }));
    graph.ingest(decisionMade({ intentId: id, at }));
    if (i < over.settle) graph.ingest(paymentSettled({ intentId: id, at }));
  }
}

/** The full two-sided evidence mix the restart tests seed and re-derive. */
function seedWorld(graph: ReputationGraph): void {
  history(graph, { host: GOOD_HOST, n: 15, settle: 15 });
  history(graph, { host: SHADY_HOST, n: 15, settle: 2 });
  graph.report({ subject: { kind: 'vendor', id: SHADY_HOST }, kind: 'dispute', at: daysAgo(3) });
  graph.report({ subject: { kind: 'vendor', id: SHADY_HOST }, kind: 'dispute', at: daysAgo(2) });
  graph.report({ subject: { kind: 'vendor', id: GOOD_HOST }, kind: 'endorsement', at: daysAgo(1) });
  // Gate-side subjects (wallet payer + payTo recipient) — disjoint id space.
  for (let i = 0; i < 4; i += 1) graph.ingest(gateSettled({ at: daysAgo(10 - i) }));
  graph.ingest(gateRefused({ code: 'payment_replayed', at: daysAgo(5) }));
  graph.ingest(gateRefused({ code: 'payer_denied', at: daysAgo(4) }));
  // One shadow spend so every evidence column round-trips a NONZERO value
  // (an all-zero column would hide a hydration mix-up).
  graph.ingest({
    type: 'shadow.spend',
    at: daysAgo(6),
    agentId: AGENT,
    txHash: '0xshadow',
    chain: 'base',
    amount: '2.50',
  });
}

const dirs: string[] = [];
const opened: ReinStore[] = [];
const dbs: PGlite[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rein-graph-store-'));
  dirs.push(dir);
  return dir;
}

/** Track every store so afterEach can close stragglers (double-close is fine). */
async function open(dir?: string): Promise<ReinStore> {
  const store = await openReinStore(dir ? { dir } : {});
  opened.push(store);
  return store;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  while (dbs.length) await dbs.pop()!.close().catch(() => undefined);
});

// Data dirs are removed once at the END of the suite: PGlite's emscripten FS
// can flush a moment after close() resolves, and deleting the dir under a
// straggler surfaces as an unhandled ENOENT pinned on the next test.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best-effort: stray temp dirs are harmless
    }
  }
});

describe('graph evidence on openReinStore', () => {
  it('resumes subjects across a restart and reports the count', async () => {
    const dir = tempDir();
    const a = await open(dir);
    expect(a.fresh).toBe(true);
    expect(a.resumedSubjects).toBe(0);
    seedWorld(graphOn(a));
    const seeded = a.ledger.size;
    expect(seeded).toBeGreaterThan(0);
    await a.close();

    const b = await open(dir);
    expect(b.fresh).toBe(false);
    expect(b.resumedSubjects).toBe(seeded);
  });

  it('recomputes byte-identical scores from rehydrated evidence', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const graphA = graphOn(a);
    seedWorld(graphA);
    // Scores are never stored — under one fixed clock, identical evidence must
    // re-derive identical numbers. Sort by subject key: scores() orders by
    // score, and the SQL hydration order need not match insertion order.
    const canonical = (g: ReputationGraph) =>
      JSON.stringify(
        g.scores().sort((x, y) => `${x.subject.kind}:${x.subject.id}`.localeCompare(`${y.subject.kind}:${y.subject.id}`)),
      );
    const before = canonical(graphA);
    await a.close();

    const b = await open(dir);
    expect(canonical(graphOn(b))).toBe(before);
  });

  it('rehydrates the raw evidence behind a score, refusals and volume included', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const graphA = graphOn(a);
    seedWorld(graphA);
    const before = graphA.explain({ kind: 'agent', id: WALLET });
    await a.close();

    const reopened = graphOn(await open(dir));
    const after = reopened.explain({ kind: 'agent', id: WALLET });
    expect(after).toBeDefined();
    // JSONB refusal counts, TEXT decimal volume, and min/max seen timestamps
    // all round-trip exactly.
    expect(after!.evidence.refusals).toEqual({ payment_replayed: 1, payer_denied: 1 });
    expect(after!.evidence).toEqual(before!.evidence);
    // The engine agent carries the seed's one shadow spend — a NONZERO value
    // for the column, so a hydration mix-up cannot hide behind 0 == 0.
    expect(reopened.explain({ kind: 'agent', id: AGENT })!.evidence.shadowSpends).toBe(1);
  });

  it('rehydrates counterparty edges (a missing peer would silently degrade quality to 50)', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const graphA = graphOn(a);
    seedWorld(graphA);
    const before = graphA.explain({ kind: 'vendor', id: GOOD_HOST })!;
    // The seed gives good-feeds one settled-money peer: the engine agent.
    expect(before.evidence.counterparties).toHaveLength(1);
    // The peer has settled with BOTH vendors, so its base score is not the
    // lonely-subject neutral 50 — if the edge or the peer failed to rehydrate,
    // counterpartyQuality would fall back to exactly 50 with no error.
    expect(before.score.components.counterpartyQuality).not.toBe(50);
    await a.close();

    const after = graphOn(await open(dir)).explain({ kind: 'vendor', id: GOOD_HOST })!;
    expect(after.evidence.counterparties).toEqual(before.evidence.counterparties);
    expect(after.score.components.counterpartyQuality).toBe(
      before.score.components.counterpartyQuality,
    );
  });

  it('attributes a payment.settled that lands after a restart (in-flight intent survives)', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const graphA = graphOn(a);
    const id = newId('int');
    const at = daysAgo(2);
    graphA.ingest(intentCreated({ id, host: GOOD_HOST, amount: '0.25', at }));
    graphA.ingest(decisionMade({ intentId: id, at }));
    expect(a.intents.size).toBe(1);
    await a.close();

    // The settlement arrives in a NEW process — before S15 this was silently
    // unattributable (the correlation map died with the old one).
    const b = await open(dir);
    expect(b.intents.size).toBe(1);
    const graphB = graphOn(b);
    graphB.ingest(paymentSettled({ intentId: id, at: daysAgo(2) }));
    const vendor = graphB.explain({ kind: 'vendor', id: GOOD_HOST })!.evidence;
    expect(vendor.settled).toBe(1);
    expect(vendor.volume).toBe('0.25');
    const agent = graphB.explain({ kind: 'agent', id: AGENT })!.evidence;
    expect(agent.settled).toBe(1);
    // Attribution consumed the entry.
    expect(b.intents.size).toBe(0);
  });

  it('persists intent consumption — a replayed settlement cannot double-count after restart', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const graphA = graphOn(a);
    const id = newId('int');
    const at = daysAgo(2);
    graphA.ingest(intentCreated({ id, host: GOOD_HOST, at }));
    graphA.ingest(decisionMade({ intentId: id, at }));
    graphA.ingest(paymentSettled({ intentId: id, at }));
    expect(graphA.explain({ kind: 'vendor', id: GOOD_HOST })!.evidence.settled).toBe(1);
    await a.close();

    // If the take() delete had not persisted, this replay would settle again.
    const b = await open(dir);
    expect(b.intents.size).toBe(0);
    const graphB = graphOn(b);
    graphB.ingest(paymentSettled({ intentId: id, at }));
    expect(graphB.explain({ kind: 'vendor', id: GOOD_HOST })!.evidence.settled).toBe(1);
  });

  it('runs fully in-memory when no dir is given', async () => {
    const store = await open();
    const graph = graphOn(store);
    seedWorld(graph);
    expect(store.resumedSubjects).toBe(0);
    const good = graph.score({ kind: 'vendor', id: GOOD_HOST })!;
    const shady = graph.score({ kind: 'vendor', id: SHADY_HOST })!;
    expect(good.score).toBeGreaterThan(shady.score);
    await graph.flush();
  });

  it('persists identity merges — a boot-time re-link after restart cannot double-count', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const graphA = graphOn(a);
    // Engine-side history on the ULID, gate-side history on the wallet.
    const id = newId('int');
    graphA.ingest(intentCreated({ id, host: GOOD_HOST, at: daysAgo(5) }));
    graphA.ingest(decisionMade({ intentId: id, at: daysAgo(5) }));
    graphA.ingest(paymentSettled({ intentId: id, at: daysAgo(5) }));
    graphA.ingest(gateSettled({ at: daysAgo(4) }));
    graphA.ingest(gateSettled({ at: daysAgo(3) }));
    graphA.link({ kind: 'agent', id: AGENT }, { kind: 'agent', id: WALLET });
    const canon = (g: ReputationGraph) => {
      const e = g.explain({ kind: 'agent', id: AGENT })!.evidence;
      return {
        ...e,
        counterparties: [...e.counterparties].sort((x, y) =>
          x.subject.id.localeCompare(y.subject.id),
        ),
      };
    };
    const before = canon(graphA);
    expect(before.settled).toBe(3); // 1 engine-side + 2 gate-side, one subject
    await a.close();

    const b = await open(dir);
    const graphB = graphOn(b);
    // Links are derived state — the world re-asserts them at boot. The merge
    // already persisted (alias row deleted in the same transaction), so this
    // MUST be a no-op; an unpersisted merge would fold the alias again here.
    graphB.link({ kind: 'agent', id: AGENT }, { kind: 'agent', id: WALLET });
    await graphB.flush();
    expect(canon(graphB)).toEqual(before);
    expect(graphB.scores('agent')).toHaveLength(1);
    // New wallet evidence still lands on the canonical subject.
    graphB.ingest(gateSettled({ at: daysAgo(1) }));
    expect(canon(graphB).settled).toBe(4);
  });

  it('surfaces a failed durable write on the next flush() instead of pretending it persisted', async () => {
    const store = await open();
    const graph = graphOn(store);
    await store.close();
    // The bus keeps firing into a store whose database is gone: the mirror
    // still accepts the write (fire-and-forget must not crash the process),
    // but flush() — the durability checkpoint the HTTP route awaits — throws.
    graph.ingest(gateSettled({ at: daysAgo(1) }));
    await expect(graph.flush()).rejects.toThrow();
    // The failure was consumed: a later flush over a settled queue is clean.
    await expect(graph.flush()).resolves.toBeUndefined();
  });

  it('keeps a thin history below the confidence floor across restarts (fairness survives)', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const graphA = graphOn(a);
    // Two attempts yesterday: real evidence, but far too thin to condemn or
    // certify anyone. It must persist WITHOUT graduating into confidence.
    const id = newId('int');
    graphA.ingest(intentCreated({ id, host: 'newcomer.test', at: daysAgo(1) }));
    graphA.ingest(decisionMade({ intentId: id, at: daysAgo(1) }));
    const id2 = newId('int');
    graphA.ingest(intentCreated({ id: id2, host: 'newcomer.test', at: daysAgo(1) }));
    graphA.ingest(decisionMade({ intentId: id2, at: daysAgo(1) }));
    const before = graphA.score({ kind: 'vendor', id: 'newcomer.test' })!;
    expect(before.confidence).toBeLessThan(0.3);
    await a.close();

    const graphB = graphOn(await open(dir));
    const after = graphB.score({ kind: 'vendor', id: 'newcomer.test' })!;
    expect(after.confidence).toBe(before.confidence);
    const pushed: string[] = [];
    await graphB.syncVendors(
      { setVendorReputation: (host) => void pushed.push(host) },
      { minConfidence: 0.3 },
    );
    expect(pushed).not.toContain('newcomer.test');
  });
});

describe('PgIntentStore', () => {
  it('mirrors the FIFO bound in SQL so never-settled intents cannot grow the table', async () => {
    const db = await openDb();
    dbs.push(db);
    const store = await PgIntentStore.open(db, 3);
    for (let i = 1; i <= 5; i += 1) {
      await store.remember(`int_${i}`, { agentId: AGENT, host: GOOD_HOST, amount: '0.01' });
    }
    await store.flush();
    expect(store.size).toBe(3);
    // Oldest two evicted from memory AND from the mirror.
    expect(store.peek('int_1')).toBeUndefined();
    expect(store.peek('int_2')).toBeUndefined();
    const rows = await db.query<{ intent_id: string }>(
      'SELECT intent_id FROM graph_intents ORDER BY seq',
    );
    expect(rows.rows.map((r) => r.intent_id)).toEqual(['int_3', 'int_4', 'int_5']);
  });

  it('treats re-remembering an in-flight intent as an update — no live entry is evicted', async () => {
    const db = await openDb();
    dbs.push(db);
    const store = await PgIntentStore.open(db, 3);
    for (const id of ['int_a', 'int_b', 'int_c']) {
      await store.remember(id, { agentId: AGENT, host: GOOD_HOST, amount: '0.01' });
    }
    // A retried HTTP batch re-delivers int_b at capacity: an update adds no
    // entry, so nothing may be evicted from memory OR trimmed from SQL.
    await store.remember('int_b', { agentId: AGENT, host: GOOD_HOST, amount: '0.99' });
    await store.flush();
    expect(store.size).toBe(3);
    expect(store.peek('int_a')).toBeDefined();
    expect(store.peek('int_b')!.amount).toBe('0.99');
    const rows = await db.query<{ intent_id: string }>(
      'SELECT intent_id FROM graph_intents ORDER BY seq',
    );
    expect(rows.rows.map((r) => r.intent_id)).toEqual(['int_a', 'int_b', 'int_c']);
  });
});
