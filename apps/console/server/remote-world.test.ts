/**
 * The console as a read-key client of a hosted engine (Sprint 5.1/5.2).
 *
 * Everything here runs against a FAKE engine rather than a booted one: the
 * thing under test is the mapping from the engine's wire shapes onto
 * `ConsoleState`, plus what the world does when that engine misbehaves. A real
 * engine would exercise the mapping and hide the failure paths, which are the
 * half that decides whether a public dashboard lies.
 */
import { describe, expect, it, vi } from 'vitest';
import { createRemoteWorld, fingerprintPem } from './remote-world';
import type { ServerEvent } from './wire';

const KEY = 'rk_test';
const ENGINE = 'https://engine.example';

const PEM = '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEA\n-----END PUBLIC KEY-----\n';

interface FakeEngine {
  agents: unknown[];
  policies: unknown[];
  liveness: unknown[];
  reconciliation: unknown;
  approvals: unknown[];
  approvers: unknown[];
  breakers: Record<string, unknown[]>;
  decisions: unknown[];
  /** Paths that should fail, mapped to the status to answer. */
  fail: Map<string, number>;
}

function emptyEngine(): FakeEngine {
  return {
    agents: [],
    policies: [],
    liveness: [],
    reconciliation: {
      window: '24h',
      graceMs: 60_000,
      allowed: 0,
      allowedValue: '0',
      settled: 0,
      settledValue: '0',
      inFlight: 0,
      inFlightValue: '0',
      unsettled: 0,
      unsettledValue: '0',
      overspent: 0,
      overspentValue: '0',
      unattributed: 0,
      settlementsSeen: 0,
      gaps: [],
    },
    approvals: [],
    approvers: [],
    breakers: {},
    decisions: [],
    fail: new Map(),
  };
}

function decision(n: number, outcome: 'allow' | 'deny' | 'escalate' = 'allow'): unknown {
  return {
    id: `dec_${n}`,
    intentId: `int_${n}`,
    intentHash: `hash_intent_${n}`,
    outcome,
    matchedRules: [`rule-${n}`],
    reason: `because ${n}`,
    policyId: 'pol_1',
    prevHash: n === 0 ? 'genesis' : `hash_${n - 1}`,
    hash: `hash_${n}`,
    latencyMs: 10,
    decidedAt: new Date(1_700_000_000_000 + n * 1000).toISOString(),
  };
}

/** A fetch that answers the engine's read surface out of a mutable fixture. */
function fakeFetch(engine: FakeEngine): { impl: typeof fetch; calls: string[] } {
  const calls: string[] = [];
  const impl = (async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(String(input));
    const path = url.pathname + url.search;
    calls.push(path);

    const failure = engine.fail.get(url.pathname);
    if (failure !== undefined) {
      return new Response('nope', { status: failure });
    }

    const json = (body: unknown, headers?: Record<string, string>): Response =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json', ...headers },
      });

    if (url.pathname === '/health') return json({ status: 'ok', publicKey: PEM });
    if (url.pathname === '/v1/agents') return json(engine.agents);
    if (url.pathname === '/v1/policies') return json(engine.policies);
    if (url.pathname === '/v1/liveness') return json(engine.liveness);
    if (url.pathname === '/v1/reconciliation') return json(engine.reconciliation);
    if (url.pathname === '/v1/approvals') return json(engine.approvals);
    if (url.pathname === '/v1/approvers') return json(engine.approvers);

    const breakerMatch = /^\/v1\/agents\/([^/]+)\/breakers$/.exec(url.pathname);
    if (breakerMatch) return json(engine.breakers[breakerMatch[1] as string] ?? []);

    if (url.pathname === '/v1/decisions') {
      const total = engine.decisions.length;
      const limit = url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 500;
      // The real engine validates `after` as nonnegative and expresses "from
      // the start" by its ABSENCE (services/policy-engine/src/server.ts:160).
      // This fake used to accept -1 -- which is the CONSOLE's own sentinel --
      // so a console that leaked the sentinel onto the wire passed every test
      // here and 400'd in production against any chain shorter than
      // FEED_SEED + 1. Every young engine is such a chain.
      const rawAfter = url.searchParams.get('after');
      if (rawAfter !== null && Number(rawAfter) < 0) {
        return new Response('after must be nonnegative', { status: 400 });
      }
      const after = rawAfter === null ? -1 : Number(rawAfter);
      const start = after + 1;
      const page = engine.decisions.slice(start, start + limit);
      const headers: Record<string, string> = { 'Rein-Chain-Length': String(total) };
      if (start + page.length < total) {
        headers['Rein-Next-After'] = String(start + page.length - 1);
      }
      return json(page, headers);
    }
    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

async function world(engine: FakeEngine, extra: { pollMs?: number } = {}) {
  const { impl, calls } = fakeFetch(engine);
  const w = await createRemoteWorld({
    engineUrl: ENGINE,
    apiKey: KEY,
    fetchImpl: impl,
    // Long enough that no test races the timer; every test drives `refresh()`.
    pollMs: extra.pollMs ?? 3_600_000,
  });
  return { w, calls };
}

describe('createRemoteWorld — rendering a hosted engine', () => {
  it('maps agents, liveness and policies into the console state', async () => {
    const engine = emptyEngine();
    engine.agents = [
      {
        id: 'agt_1',
        name: 'researcher',
        labels: ['research'],
        status: 'active',
        wallets: [{ chain: 'base', address: '0xabc', mode: 'observed' }],
        createdAt: '2026-09-01T00:00:00.000Z',
      },
    ];
    engine.liveness = [
      {
        agentId: 'agt_1',
        expectation: { interval: '5m', note: 'hourly sweep' },
        status: 'late',
        silentMs: 400_000,
        lastSeenAt: 1_700_000_000_000,
        lastSource: 'intent',
      },
    ];
    engine.policies = [
      {
        policyId: 'pol_1',
        version: '1',
        default: 'deny',
        appliesTo: { agents: ['agt_1'], labels: ['research'] },
        rules: [{ id: 'r1', deny: { amountGt: '5.00' } }],
      },
    ];

    const { w } = await world(engine);
    const state = w.getState();

    expect(state.agents).toHaveLength(1);
    expect(state.agents[0]).toMatchObject({
      id: 'agt_1',
      name: 'researcher',
      status: 'active',
      chain: 'base',
      address: '0xabc',
    });
    expect(state.agents[0]?.liveness).toMatchObject({
      interval: '5m',
      status: 'late',
      note: 'hourly sweep',
    });
    expect(state.policies[0]?.rules[0]).toEqual({
      id: 'r1',
      action: 'deny',
      summary: 'amount > $5.00',
    });
    await w.close();
  });

  /**
   * The reason `visibleAgents` had to resolve the kill switch rather than echo
   * the stored document: this console has no second source. Whatever that
   * field says is what an operator reads as the kill-switch state.
   */
  it('renders a frozen agent as frozen, from the listing alone', async () => {
    const engine = emptyEngine();
    engine.agents = [
      { id: 'agt_1', name: 'halted', status: 'frozen', createdAt: '2026-09-01T00:00:00.000Z' },
    ];
    const { w } = await world(engine);
    expect(w.getState().agents[0]?.status).toBe('frozen');
    await w.close();
  });

  it('leaves the gate, signer and graph panels empty rather than inventing them', async () => {
    const { w } = await world(emptyEngine());
    const state = w.getState();
    expect(state.gate).toMatchObject({ quoted: 0, settled: 0, revenue: '0', routes: [] });
    expect(state.signer).toEqual({ sessions: [], active: 0 });
    expect(state.graph.subjects).toBe(0);
    expect(state.graph.lastSyncAt).toBeNull();
    await w.close();
  });

  it('carries the reconciliation honesty valve through unchanged', async () => {
    const engine = emptyEngine();
    (engine.reconciliation as Record<string, unknown>).settlementsSeen = 0;
    (engine.reconciliation as Record<string, unknown>).unsettled = 3;
    (engine.reconciliation as Record<string, unknown>).gaps = [
      {
        intentId: 'int_9',
        decisionId: 'dec_9',
        agentId: 'agt_1',
        host: 'vendor.example',
        resource: '/v1/ping',
        amount: '0.010000',
        allowedAt: 1_700_000_000_000,
        ageMs: 90_000,
        state: 'unsettled',
      },
    ];
    engine.agents = [{ id: 'agt_1', name: 'researcher', createdAt: '2026-09-01T00:00:00.000Z' }];

    const { w } = await world(engine);
    const recon = w.getState().reconciliation;
    expect(recon.settlementsSeen).toBe(0);
    expect(recon.unsettled).toBe(3);
    expect(recon.gaps[0]).toMatchObject({
      intentId: 'int_9',
      agentName: 'researcher',
      state: 'unsettled',
    });
    await w.close();
  });

  it('renders escalations without challenge bytes it could never submit', async () => {
    const engine = emptyEngine();
    engine.approvers = [{ id: 'apk_1', name: 'founder' }, { id: 'apk_2', name: 'old', revokedAt: '2026-01-01T00:00:00.000Z' }];
    engine.approvals = [
      {
        decisionId: 'dec_5',
        intentId: 'int_5',
        intentHash: 'hash_intent_5',
        agentId: 'agt_1',
        vendorHost: 'vendor.example',
        resource: '/v1/ping',
        amount: '1.00',
        reason: 'breaker tripped',
        breakers: ['brk_1'],
        status: 'pending',
        createdAt: '2026-09-01T00:00:00.000Z',
        expiresAt: '2099-01-01T00:00:00.000Z',
      },
    ];
    const { w } = await world(engine);
    const esc = w.getState().escalations;
    expect(esc.approvers).toEqual([{ id: 'apk_1', name: 'founder' }]);
    expect(esc.pending).toHaveLength(1);
    expect(esc.pending[0]?.challenge).toBeUndefined();
    await w.close();
  });

  it('keeps rendering when the engine has no approvals wired', async () => {
    const engine = emptyEngine();
    engine.agents = [{ id: 'agt_1', name: 'researcher', createdAt: '2026-09-01T00:00:00.000Z' }];
    engine.fail.set('/v1/approvals', 503);
    engine.fail.set('/v1/approvers', 503);

    const { w } = await world(engine);
    expect(w.status().state).toBe('ok');
    expect(w.getState().agents).toHaveLength(1);
    expect(w.getState().escalations.pending).toEqual([]);
    await w.close();
  });

  it('keeps the other panels when one agent’s breakers fail', async () => {
    const engine = emptyEngine();
    engine.agents = [
      { id: 'agt_1', name: 'a', createdAt: '2026-09-01T00:00:00.000Z' },
      { id: 'agt_2', name: 'b', createdAt: '2026-09-01T00:00:00.000Z' },
    ];
    engine.breakers['agt_2'] = [
      {
        breaker: { id: 'brk_1', window: '1h', txCount: 5 },
        policyId: 'pol_1',
        txCount: 6,
        sum: '3.00',
        countingFrom: 1_700_000_000_000,
        tripped: true,
        reason: 'too many',
      },
    ];
    engine.fail.set('/v1/agents/agt_1/breakers', 500);

    const { w } = await world(engine);
    expect(w.status().state).toBe('ok');
    expect(w.getState().breakers).toHaveLength(1);
    expect(w.getState().breakers[0]).toMatchObject({ agentId: 'agt_2', tripped: true });
    await w.close();
  });
});

describe('createRemoteWorld — the decision feed', () => {
  it('seeds near the head instead of replaying the whole chain', async () => {
    const engine = emptyEngine();
    engine.decisions = Array.from({ length: 400 }, (_, i) => decision(i));

    const { w } = await world(engine);
    const state = w.getState();
    // 50 seeded, not 400 — and the all-time counter still reports the chain.
    expect(state.feed).toHaveLength(50);
    expect(state.stats.decisions).toBe(400);
    expect(state.stats.chainLinks).toBe(400);
    expect(state.feed.at(-1)?.decisionId).toBe('dec_399');
    await w.close();
  });

  it('asks for the whole chain by omitting `after`, never by sending -1', async () => {
    // A chain shorter than the feed seed leaves the cursor at -1, and -1 is
    // the console's sentinel for "nothing read yet" -- not a position the
    // engine accepts. Sending it answers 400 and the dashboard reports the
    // engine unreachable while the engine is perfectly healthy, which is what
    // app.reinconsole.com did on its first deploy against a six-decision
    // chain (S70).
    const engine = emptyEngine();
    engine.decisions = [decision(0), decision(1)];

    const { w, calls } = await world(engine);
    expect(calls.some((c) => c.includes('after=-1'))).toBe(false);
    expect(calls).toContain('/v1/decisions');
    expect(w.getState().feed).toHaveLength(2);
    expect(w.getState().stats.decisions).toBe(2);
    await w.close();
  });

  it('pushes only what is new on the next poll', async () => {
    const engine = emptyEngine();
    engine.decisions = [decision(0), decision(1)];

    const { w } = await world(engine);
    expect(w.getState().feed).toHaveLength(2);

    const seen: ServerEvent[] = [];
    w.subscribe((ev) => seen.push(ev));

    engine.decisions.push(decision(2, 'deny'));
    await w.refresh();

    expect(w.getState().feed).toHaveLength(3);
    const feedEvents = seen.filter((e) => e.type === 'feed');
    expect(feedEvents).toHaveLength(1);
    expect(w.getState().feed.at(-1)).toMatchObject({
      decisionId: 'dec_2',
      outcome: 'deny',
      kind: 'decision',
      reason: 'because 2',
    });
    await w.close();
  });

  it('emits nothing when a poll finds the world unchanged', async () => {
    const engine = emptyEngine();
    engine.agents = [{ id: 'agt_1', name: 'a', createdAt: '2026-09-01T00:00:00.000Z' }];
    const { w } = await world(engine);

    const seen: ServerEvent[] = [];
    w.subscribe((ev) => seen.push(ev));
    await w.refresh();
    // `at` moves every poll, so reconciliation/escalations would churn if the
    // view were compared naively; they are not, and nothing else moved.
    expect(seen.filter((e) => e.type === 'agents' || e.type === 'feed')).toEqual([]);
    await w.close();
  });

  /**
   * A decision does not carry its intent's agent, amount or host. Where a
   * reconciliation gap names the same intent the row is enriched; where none
   * does, the row still renders, thin.
   */
  it('enriches a decision row from a reconciliation gap, and renders thin without one', async () => {
    const engine = emptyEngine();
    engine.agents = [{ id: 'agt_1', name: 'researcher', createdAt: '2026-09-01T00:00:00.000Z' }];
    (engine.reconciliation as Record<string, unknown>).gaps = [
      {
        intentId: 'int_1',
        agentId: 'agt_1',
        host: 'vendor.example',
        resource: '/v1/ping',
        amount: '0.001000',
        allowedAt: 1_700_000_000_000,
        ageMs: 1000,
        state: 'in-flight',
      },
    ];
    engine.decisions = [decision(0), decision(1)];

    const { w } = await world(engine);
    const [thin, rich] = w.getState().feed;
    expect(rich).toMatchObject({
      intentId: 'int_1',
      agentId: 'agt_1',
      agentName: 'researcher',
      host: 'vendor.example',
      amount: '0.001000',
    });
    expect(thin?.agentId).toBeUndefined();
    expect(thin?.amount).toBeUndefined();
    // Thin still means renderable: the chain links are always there.
    expect(thin).toMatchObject({ decisionId: 'dec_0', hash: 'hash_0', prevHash: 'genesis' });
    await w.close();
  });

  it('reports allow/deny/escalate over the window it actually read', async () => {
    const engine = emptyEngine();
    engine.decisions = [decision(0, 'allow'), decision(1, 'deny'), decision(2, 'escalate')];
    const { w } = await world(engine);
    expect(w.getState().stats).toMatchObject({ allow: 1, deny: 1, escalate: 1, decisions: 3 });
    await w.close();
  });
});

describe('createRemoteWorld — holding no authority', () => {
  it('refuses every mutation by construction', async () => {
    const { w } = await world(emptyEngine());
    await expect(w.freeze('agt_1')).resolves.toBe(false);
    await expect(w.unfreeze('agt_1')).resolves.toBe(false);
    await expect(w.pingAgent('agt_1')).resolves.toBe(false);
    expect(w.runDemo()).toBe(false);
    expect(() =>
      w.submitGrant({
        decisionId: 'dec_1',
        intentHash: 'h',
        verdict: 'approve',
        approverKeyId: 'apk_1',
        signature: 'sig',
      }),
    ).toThrow(/read-only client/);
    await w.close();
  });

  it('never asks the engine to change anything', async () => {
    const engine = emptyEngine();
    engine.agents = [{ id: 'agt_1', name: 'a', createdAt: '2026-09-01T00:00:00.000Z' }];
    const { w, calls } = await world(engine);
    await w.freeze('agt_1');
    await w.refresh();
    // Every path touched is a read. A mutation would have to appear here
    // first to become a posture failure in production.
    expect(calls.every((p) => !p.includes('freeze') && !p.includes('resolve'))).toBe(true);
    await w.close();
  });
});

describe('createRemoteWorld — when the engine is unreachable', () => {
  it('comes up rather than throwing, and says it has not reached the engine', async () => {
    const engine = emptyEngine();
    engine.fail.set('/health', 502);
    const { w } = await world(engine);
    expect(w.status().state).toBe('unreachable');
    expect(w.status().error).toContain('502');
    // The page still serves: empty, and honest about being empty.
    expect(w.getState().agents).toEqual([]);
    expect(w.getState().reconciliation.settlementsSeen).toBe(0);
    await w.close();
  });

  it('keeps the last good state instead of blanking the dashboard', async () => {
    const engine = emptyEngine();
    engine.agents = [{ id: 'agt_1', name: 'researcher', createdAt: '2026-09-01T00:00:00.000Z' }];
    const { w } = await world(engine);
    expect(w.status().state).toBe('ok');

    engine.fail.set('/v1/agents', 500);
    await w.refresh();

    expect(w.status().state).toBe('unreachable');
    // The agent did not go away just because one poll failed.
    expect(w.getState().agents).toHaveLength(1);
    await w.close();
  });

  it('recovers on a later poll', async () => {
    const engine = emptyEngine();
    engine.fail.set('/health', 502);
    const { w } = await world(engine);
    expect(w.status().state).toBe('unreachable');

    engine.fail.delete('/health');
    engine.agents = [{ id: 'agt_1', name: 'researcher', createdAt: '2026-09-01T00:00:00.000Z' }];
    await w.refresh();

    expect(w.status().state).toBe('ok');
    expect(w.status().error).toBeUndefined();
    expect(w.getState().agents).toHaveLength(1);
    await w.close();
  });

  it('stops polling after close', async () => {
    vi.useFakeTimers();
    try {
      const engine = emptyEngine();
      const { w, calls } = await world(engine, { pollMs: 50 });
      const afterBoot = calls.length;
      await w.close();
      await vi.advanceTimersByTimeAsync(500);
      expect(calls.length).toBe(afterBoot);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('fingerprintPem', () => {
  /**
   * S60 lost an afternoon to a fingerprint recipe that hashed line endings:
   * the same key reported two different values on two machines and read as a
   * key mismatch. Whitespace is stripped so transport cannot change the answer.
   */
  it('is the same value however the PEM was transported', () => {
    const lf = PEM;
    const crlf = PEM.replace(/\n/g, '\r\n');
    const noTrailer = PEM.trimEnd();
    expect(fingerprintPem(crlf)).toBe(fingerprintPem(lf));
    expect(fingerprintPem(noTrailer)).toBe(fingerprintPem(lf));
  });

  it('is 16 hex characters, and different keys differ', () => {
    expect(fingerprintPem(PEM)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprintPem(PEM.replace('MCowBQYDK2VwAyEA', 'MCowBQYDK2VwAyEB'))).not.toBe(
      fingerprintPem(PEM),
    );
  });

  it('is reported on the status once a poll has seen the key', async () => {
    const { w } = await world(emptyEngine());
    expect(w.status().publicKeyFingerprint).toBe(fingerprintPem(PEM));
    await w.close();
  });
});
