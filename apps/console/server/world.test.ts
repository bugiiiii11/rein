/**
 * The console world, booted for real: the actual engine over HTTP, the actual
 * gate/signer/graph, mock rails — `createWorld()` runs the full 15-beat boot
 * scenario unpaced, so a fresh in-memory world arrives with a deterministic
 * story already told. These tests pin that story's fingerprint: if a scenario
 * beat, a policy rule, or an event-wiring seam regresses, the numbers move.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld, decodeEvmPayment, type World } from './world';
import type { ConsoleState } from './wire';

let world: World;
/** Snapshot taken immediately after boot, BEFORE any mutation tests run. */
let boot: ConsoleState;

beforeAll(async () => {
  world = await createWorld();
  boot = world.getState();
}, 60_000);

afterAll(async () => {
  await world.close();
});

describe('boot scenario fingerprint', () => {
  it('provisions exactly the three scenario agents, each with its own policy', () => {
    expect(boot.agents.map((a) => a.name).sort()).toEqual([
      'procurement-agent-1',
      'research-agent-1',
      'session-agent-1',
    ]);
    expect(boot.policies).toHaveLength(3);
    for (const p of boot.policies) {
      expect(p.default).toBe('allow');
      expect(p.rules.map((r) => r.id).sort()).toEqual(['hour-budget', 'reputation-gate', 'tx-cap']);
    }
    // The role slug becomes a semantic label (S30).
    const research = boot.agents.find((a) => a.name === 'research-agent-1');
    expect(research?.labels).toEqual(['research']);
  });

  it('made 11 decisions: 8 allow, 3 deny, 0 escalate — one deny per guard rule', () => {
    expect(boot.stats.decisions).toBe(11);
    expect(boot.stats.allow).toBe(8);
    expect(boot.stats.deny).toBe(3);
    expect(boot.stats.escalate).toBe(0);
    // Every decision is on the audit chain.
    expect(boot.stats.chainLinks).toBe(11);
    const denies = boot.feed.filter((f) => f.kind === 'decision' && f.outcome === 'deny');
    const matched = denies.map((d) => [...(d.matchedRules ?? [])].sort());
    // The $5 premium call trips BOTH guards at once: over the tx cap AND over
    // what remains of the hour budget. The other two denies match one rule each.
    expect(matched).toContainEqual(['hour-budget', 'tx-cap']);
    expect(matched).toContainEqual(['hour-budget']);
    expect(matched).toContainEqual(['reputation-gate']);
  });

  it('settled 7 payments worth $0.07 and caught the one $2.50 bypass as shadow spend', () => {
    expect(boot.stats.settled).toBe(7);
    expect(Number(boot.stats.settledValue)).toBeCloseTo(0.07);
    expect(boot.stats.shadow).toBe(1);
    expect(Number(boot.stats.shadowValue)).toBeCloseTo(2.5);
  });

  it('gate: 7 settles, $0.07 revenue, 4 refusals with 4 distinct codes incl. a replay burn', () => {
    expect(boot.gate.settled).toBe(7);
    expect(Number(boot.gate.revenue)).toBeCloseTo(0.07);
    expect(boot.gate.refused).toBe(4);
    const refusals = boot.feed.filter((f) => f.kind === 'gate-refused');
    expect(refusals).toHaveLength(4);
    // Static denylist and dynamic low-reputation screening share `payer_denied`
    // by design — a refused payer is a refused payer.
    const codes = refusals.map((r) => r.code).sort();
    expect(codes).toEqual([
      'payer_denied',
      'payer_denied',
      'payment_replayed',
      'velocity_exceeded',
    ]);
    // All revenue came through the $0.01 query route; the $5 premium never settled.
    const query = boot.gate.routes.find((r) => r.route === '/v1/query');
    expect(query?.settled).toBe(7);
    for (const r of boot.gate.routes) {
      if (r.route !== '/v1/query') expect(r.settled).toBe(0);
    }
  });

  it('gate payers resolve to managed agents: 4 + 2 + 1 settles across the three wallets', () => {
    const byName = new Map(boot.gate.payers.map((p) => [p.agentName, p.settled]));
    expect(byName.get('research-agent-1')).toBe(4);
    expect(byName.get('session-agent-1')).toBe(2);
    expect(byName.get('procurement-agent-1')).toBe(1);
  });

  it('signer: one active capped session, 2 releases, 2 refusals (stolen voucher + cap)', () => {
    expect(boot.stats.sigReleased).toBe(2);
    expect(boot.stats.sigRefused).toBe(2);
    expect(boot.signer.sessions).toHaveLength(1);
    expect(boot.signer.active).toBe(1);
    const s = boot.signer.sessions[0]!;
    expect(s.agentName).toBe('session-agent-1');
    expect(s.status).toBe('active');
    expect(s.cap).toBe('0.02');
    expect(Number(s.spent)).toBeCloseTo(0.02); // the cap is exactly spent
    expect(s.burns).toBe(2);
    expect(s.wallet).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it('reputation: seeded vendors are scored and synced, the offender wallet is barred', () => {
    expect(boot.graph.denyBelow).toBe(40);
    expect(boot.graph.minConfidence).toBe(0.3);
    const vendor = (host: string) => boot.graph.vendors.find((v) => v.id === host);
    const good = vendor('good-feeds.test');
    const shady = vendor('shady-data.test');
    expect(good).toBeDefined();
    expect(shady).toBeDefined();
    // 15/15 settled vs 2/15 + disputes: the scores must sit on opposite sides
    // of the floor, and both histories are old enough to be enforceable.
    expect(good!.score).toBeGreaterThan(40);
    expect(shady!.score).toBeLessThan(40);
    expect(good!.synced).toBe(true);
    expect(shady!.synced).toBe(true);
    // The world's own vendor only has same-day evidence — confidence-discounted,
    // so its score is never pushed into enforcement on boot day.
    const own = vendor('api.data.test');
    expect(own).toBeDefined();
    expect(own!.synced).toBe(false);
    const offender = boot.graph.agents.find(
      (a) => a.id === '0xdefec7ed0000000000000000000000000000d00d',
    );
    expect(offender).toBeDefined();
    expect(offender!.barred).toBe(true);
  });

  it('exposes the audit surface: engine public key, ISO startedAt, idle demo', () => {
    expect(boot.publicKey).toContain('BEGIN PUBLIC KEY');
    expect(Number.isNaN(Date.parse(boot.startedAt))).toBe(false);
    expect(boot.demo).toEqual({ running: false, phase: 'idle' });
    // Feed is capped telemetry with a strictly increasing sequence.
    expect(boot.feed.length).toBeLessThanOrEqual(300);
    for (let i = 1; i < boot.feed.length; i += 1) {
      expect(boot.feed[i]!.seq).toBeGreaterThan(boot.feed[i - 1]!.seq);
    }
  });
});

describe('world methods', () => {
  it('freeze/unfreeze flip agent status and reject unknown ids', async () => {
    const agent = world.getState().agents.find((a) => a.name === 'research-agent-1')!;
    expect(await world.freeze('agt_does-not-exist')).toBe(false);
    expect(await world.freeze(agent.id)).toBe(true);
    expect(world.getState().agents.find((a) => a.id === agent.id)?.status).toBe('frozen');

    // A frozen agent's ping is governed, not crashed: the engine denies it and
    // the refusal lands on the feed as a decision.
    const before = world.getState().stats.decisions;
    expect(await world.pingAgent(agent.id)).toBe(true);
    const after = world.getState();
    expect(after.stats.decisions).toBe(before + 1);
    const last = [...after.feed].reverse().find((f) => f.kind === 'decision');
    expect(last?.agentId).toBe(agent.id);
    expect(last?.outcome).toBe('deny');

    expect(await world.unfreeze(agent.id)).toBe(true);
    expect(world.getState().agents.find((a) => a.id === agent.id)?.status).toBe('active');
  });

  it('pingAgent returns false for an unknown runtime', async () => {
    expect(await world.pingAgent('agt_nobody')).toBe(false);
  });

  it('subscribe delivers events and unsubscribe really detaches', async () => {
    const seen: string[] = [];
    const unsubscribe = world.subscribe((ev) => seen.push(ev.type));
    const agent = world.getState().agents.find((a) => a.name === 'procurement-agent-1')!;
    await world.pingAgent(agent.id);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).toContain('feed');

    unsubscribe();
    // Let the debounced reputation sync (250ms) drain before counting.
    await new Promise((r) => setTimeout(r, 400));
    const settled = seen.length;
    await world.pingAgent(agent.id);
    await new Promise((r) => setTimeout(r, 400));
    expect(seen.length).toBe(settled);
  });
});

describe('decodeEvmPayment', () => {
  const auth = {
    from: '0x7e57000000000000000000000000000000000001',
    to: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
    value: '10000',
    validAfter: '0',
    validBefore: '9999999999',
    nonce: `0x${'ab'.repeat(32)}`,
  };
  const evmPayload = { signature: `0x${'cd'.repeat(65)}`, authorization: auth };
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

  it('decodes a v1 exact-EVM header', () => {
    const decoded = decodeEvmPayment(
      encode({ x402Version: 1, scheme: 'exact', network: 'base', payload: evmPayload }),
    );
    expect(decoded?.scheme).toBe('exact');
    expect(decoded?.network).toBe('base');
    expect(decoded?.payload.authorization.value).toBe('10000');
  });

  it('unwraps a v2 envelope to the same inner shape', () => {
    const decoded = decodeEvmPayment(
      encode({
        x402Version: 2,
        accepted: {
          scheme: 'exact',
          network: 'eip155:8453',
          amount: '10000',
          asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
          payTo: '0x7e57000000000000000000000000000000000001',
        },
        payload: evmPayload,
      }),
    );
    expect(decoded?.x402Version).toBe(1);
    expect(decoded?.scheme).toBe('exact');
    expect(decoded?.network).toBe('eip155:8453');
  });

  it('rejects a v2 envelope whose accepted block does not parse', () => {
    expect(
      decodeEvmPayment(
        encode({ x402Version: 2, accepted: { scheme: 'exact' }, payload: evmPayload }),
      ),
    ).toBeUndefined();
  });

  it('returns undefined for flat mock payloads and garbage', () => {
    // The world's own mock header shape — must fall through to the mock rails.
    expect(
      decodeEvmPayment(
        encode({
          x402Version: 1,
          scheme: 'exact',
          network: 'base',
          payload: { from: auth.from, to: auth.to, value: '10000', asset: auth.to },
        }),
      ),
    ).toBeUndefined();
    expect(decodeEvmPayment('not-base64-json')).toBeUndefined();
    expect(decodeEvmPayment(encode('a string'))).toBeUndefined();
  });
});
