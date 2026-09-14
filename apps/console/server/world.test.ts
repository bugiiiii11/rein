/**
 * The console world, booted for real: the actual engine over HTTP, the actual
 * gate/signer/graph, mock rails — `createWorld()` runs the full 17-beat boot
 * scenario unpaced, so a fresh in-memory world arrives with a deterministic
 * story already told. These tests pin that story's fingerprint: if a scenario
 * beat, a policy rule, or an event-wiring seam regresses, the numbers move.
 *
 * The fingerprint moved ONCE, deliberately, in S46: B3 added a fourth agent on
 * a probationary envelope whose third purchase is PARKED for a human. That is
 * a scenario change, and the numbers below are its new contract — but the
 * three original agents kept every number they had, which is the property the
 * per-agent assertions guard.
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
  it('provisions exactly the four scenario agents, each with its own policy', () => {
    expect(boot.agents.map((a) => a.name).sort()).toEqual([
      'probation-agent-1',
      'procurement-agent-1',
      'research-agent-1',
      'session-agent-1',
    ]);
    expect(boot.policies).toHaveLength(4);
    for (const p of boot.policies) {
      expect(p.default).toBe('allow');
      // Every agent carries the same three deny rules — the probation agent
      // differs only in its BREAKER, which escalates rather than denying.
      expect(p.rules.map((r) => r.id).sort()).toEqual(['hour-budget', 'reputation-gate', 'tx-cap']);
    }
    // The role slug becomes a semantic label (S30).
    const research = boot.agents.find((a) => a.name === 'research-agent-1');
    expect(research?.labels).toEqual(['research']);
  });

  it('made 14 decisions: 10 allow, 3 deny, 1 escalate — one deny per guard rule', () => {
    expect(boot.stats.decisions).toBe(14);
    expect(boot.stats.allow).toBe(10);
    expect(boot.stats.deny).toBe(3);
    // Exactly one, and it is a PARK rather than a refusal: a breaker sits at
    // the escalate level and never denies on its own authority.
    expect(boot.stats.escalate).toBe(1);
    // Every decision is on the audit chain.
    expect(boot.stats.chainLinks).toBe(14);
    const denies = boot.feed.filter((f) => f.kind === 'decision' && f.outcome === 'deny');
    const matched = denies.map((d) => [...(d.matchedRules ?? [])].sort());
    // The $5 premium call trips BOTH guards at once: over the tx cap AND over
    // what remains of the hour budget. The other two denies match one rule each.
    expect(matched).toContainEqual(['hour-budget', 'tx-cap']);
    expect(matched).toContainEqual(['hour-budget']);
    expect(matched).toContainEqual(['reputation-gate']);
  });

  it('settled 9 payments worth $0.09 and caught the one $2.50 bypass as shadow spend', () => {
    expect(boot.stats.settled).toBe(9);
    expect(Number(boot.stats.settledValue)).toBeCloseTo(0.09);
    expect(boot.stats.shadow).toBe(1);
    expect(Number(boot.stats.shadowValue)).toBeCloseTo(2.5);
  });

  it('gate: 9 settles, $0.09 revenue, 4 refusals with 4 distinct codes incl. a replay burn', () => {
    expect(boot.gate.settled).toBe(9);
    expect(Number(boot.gate.revenue)).toBeCloseTo(0.09);
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
    expect(query?.settled).toBe(9);
    for (const r of boot.gate.routes) {
      if (r.route !== '/v1/query') expect(r.settled).toBe(0);
    }
  });

  it('gate payers resolve to managed agents: 4 + 2 + 1 + 2 settles across four wallets', () => {
    const byName = new Map(boot.gate.payers.map((p) => [p.agentName, p.settled]));
    expect(byName.get('research-agent-1')).toBe(4);
    expect(byName.get('session-agent-1')).toBe(2);
    expect(byName.get('procurement-agent-1')).toBe(1);
    // Two inside the probationary envelope; the third never reached the gate,
    // because it was parked before any payment existed.
    expect(byName.get('probation-agent-1')).toBe(2);
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
    // The world's own vendor is born on boot day, so `age` caps its confidence
    // at 0.1 x depth however busy the scenario gets — structurally under the
    // 0.3 push floor, so it CANNOT be synced into enforcement on day one no
    // matter when the debounced sync happens to fire. Pin the ceiling first,
    // then the consequence: the guarantee is the mechanism, not the outcome.
    //
    // This assertion was briefly a race. Under the old 0.4 age floor the
    // vendor landed on confidence 0.30136 against the same 0.3 floor — inside
    // its own grace period by 0.0014 — so whether scheduleSync()'s 250ms
    // debounce fired before or after the final beat decided the result. It
    // held on ubuntu and flipped on windows CI (run 32165285924).
    const own = vendor('api.data.test');
    expect(own).toBeDefined();
    expect(Date.parse(own!.firstSeen)).toBeGreaterThan(Date.now() - 60 * 60 * 1000);
    expect(own!.confidence).toBeLessThan(0.1);
    expect(own!.synced).toBe(false);
    expect(good!.confidence).toBeGreaterThan(own!.confidence + 0.3);
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

describe('breakers (A3)', () => {
  it('arms one breaker per agent, counting the calls the scenario actually made', () => {
    expect(boot.breakers).toHaveLength(boot.agents.length);
    for (const b of boot.breakers) {
      expect(b.policyId).toBe(`policy-${b.agentName}`);
      // The floor: with no signed reset it is simply the window edge.
      expect(b.resetAt).toBeUndefined();
      expect(Number.isNaN(Date.parse(b.countingFrom))).toBe(false);
    }
    // The three established agents share the loose role envelope.
    for (const b of boot.breakers.filter((x) => x.agentName !== 'probation-agent-1')) {
      expect(b.breakerId).toBe('velocity');
      expect(b.window).toBe('24h');
      expect(b.txCap).toBe(6);
    }
    // research-agent-1 settled 4 of the 9 payments (see the gate fingerprint),
    // so its window holds 4 — the panel is reading real spend, not a stub.
    const research = boot.breakers.find((b) => b.agentName === 'research-agent-1');
    expect(research?.txCount).toBe(4);
    expect(Number(research?.sum)).toBeCloseTo(0.04);
  });

  it('leaves the three established agents COUNTING and untripped', () => {
    // The role envelope is sized to count without tripping, and adding the
    // probation agent in S46 must not have changed that: a trip on one of
    // these three would turn an allowed call into a parked escalation and
    // rewrite every count in this file. If this fails, the SHARED breaker was
    // tightened without deciding to change the scenario.
    const established = boot.breakers.filter((b) => b.agentName !== 'probation-agent-1');
    expect(established).toHaveLength(3);
    expect(established.every((b) => !b.tripped)).toBe(true);
  });

  it('trips the probation agent alone, and its trip PARKS rather than denies', () => {
    const probation = boot.breakers.find((b) => b.agentName === 'probation-agent-1');
    expect(probation?.breakerId).toBe('probation');
    expect(probation?.txCap).toBe(2);
    // Prospective: two purchases are permitted and counted, and the third —
    // the one that would carry it past the envelope — is the one that asks.
    expect(probation?.txCount).toBe(2);
    expect(probation?.tripped).toBe(true);
    expect(probation?.reason).toBeTruthy();
    // A breaker sits at the ESCALATE level and never refuses on its own: the
    // scenario's only non-allow outcome from a breaker is a park.
    expect(boot.stats.escalate).toBe(1);
    expect(boot.stats.deny).toBe(3); // unchanged — the three guard-rule denies
  });
});

describe('reconciliation (B1)', () => {
  it('joins the 10 allowances against the 9 settlements and finds the one gap', () => {
    const r = boot.reconciliation;
    expect(r.allowed).toBe(10);
    expect(r.settled).toBe(9);
    expect(Number(r.settledValue)).toBeCloseTo(0.09);
    // The scenario already contained this gap before B1 existed: beat 11, the
    // session-cap backstop. The ENGINE allowed a third $0.01 and the signer
    // refused to sign it, so the decision chain says "allowed" and no money
    // ever moved. It is still the ONLY gap after S46 added the probation
    // agent: a parked escalation is not an allowance, so it charges no budget
    // and writes no spend record — there is nothing for a settlement to
    // answer for until a human releases it.
    expect(r.gaps).toHaveLength(1);
    const gap = r.gaps[0]!;
    expect(gap.agentName).toBe('session-agent-1');
    expect(Number(gap.amount)).toBeCloseTo(0.01);
    expect(gap.decisionId).toBeDefined();
    // A payment seconds old is IN FLIGHT, not a gap: under the grace period a
    // missing settlement is the normal state of every payment.
    expect(gap.state).toBe('in-flight');
    expect(r.unsettled).toBe(0);
    expect(r.inFlight).toBe(1);
  });

  it('has a settlement source connected, so a gap is evidence and not just wiring', () => {
    // Zero reports would mean every allowance reads as unsettled because
    // nobody is looking — the panel renders that case differently on purpose.
    expect(boot.reconciliation.settlementsSeen).toBe(9);
    // Nothing predates B1 in a fresh world; every allowance carries its ids.
    expect(boot.reconciliation.unattributed).toBe(0);
  });
});

describe('dead-man monitoring (B2)', () => {
  it('watches the research poller and NOBODY else', () => {
    const byName = Object.fromEntries(boot.agents.map((a) => [a.name, a]));
    // Declared, never inferred: the session agent demonstrates custody and the
    // procurement agent demonstrates reputation. Neither promised a cadence,
    // and watching them would put two permanent alarms on a console whose
    // scenario ends by design — which teaches an operator to ignore the panel.
    expect(byName['session-agent-1']?.liveness).toBeUndefined();
    expect(byName['procurement-agent-1']?.liveness).toBeUndefined();
    expect(byName['probation-agent-1']?.liveness).toBeUndefined();

    const research = byName['research-agent-1']?.liveness;
    expect(research?.interval).toBe('5m');
    // It just ran the scenario, so it is alive and its last sighting is an
    // INTENT — the engine needs no separate heartbeat from a spending agent.
    expect(research?.status).toBe('alive');
    expect(research?.lastSource).toBe('intent');
    expect(research?.note).toBeTruthy();
  });

  it('adds no decision and changes no count — an alarm is not a gate', () => {
    // Liveness is observability: watching an agent must not move a single
    // number in the pinned boot fingerprint above.
    expect(boot.stats.decisions).toBe(14);
    expect(boot.feed.some((f) => f.kind === 'missing')).toBe(false);
  });

  it('counts a DENIED ping as a sighting — a blocked agent is alive', async () => {
    const agent = world.getState().agents.find((a) => a.name === 'research-agent-1')!;
    // The hour budget has long been spent by the scenario, so this ping is
    // denied. It is still proof of life, and the freshest sighting wins.
    const before = world.getState().agents.find((a) => a.id === agent.id)!.liveness!;
    await new Promise((r) => setTimeout(r, 5));
    expect(await world.pingAgent(agent.id)).toBe(true);
    const after = world.getState().agents.find((a) => a.id === agent.id)!.liveness!;
    expect(Date.parse(after.lastSeenAt!)).toBeGreaterThan(Date.parse(before.lastSeenAt!));
    expect(after.lastSource).toBe('intent');
    expect(after.status).toBe('alive');
  });
});

describe('escalations (A2 in the console, B3)', () => {
  it('parks the probation agent third purchase, with the bytes to sign', () => {
    const e = boot.escalations;
    expect(e.pending).toHaveLength(1);
    const parked = e.pending[0]!;
    expect(parked.agentName).toBe('probation-agent-1');
    expect(Number(parked.amount)).toBeCloseTo(0.01);
    expect(parked.status).toBe('pending');
    expect(parked.host).toBe('api.data.test');
    // An approval of this resets exactly the breaker that stopped it, so the
    // human who waves one payment through is not asked again immediately.
    expect(parked.breakers).toEqual(['probation']);
    expect(parked.reason).toBeTruthy();
    // The escalating decision is named, so the row links into the audit chain.
    expect(boot.feed.some((f) => f.kind === 'decision' && f.decisionId === parked.decisionId)).toBe(
      true,
    );
    // The two byte-strings, and nothing that could assert a verdict: the
    // console shows the challenge, it never answers it.
    expect(parked.challenge?.approve).toContain('approve');
    expect(parked.challenge?.reject).toContain('reject');
    expect(parked.challenge?.approve).toContain(parked.decisionId);
    expect(parked.challenge?.approve).not.toBe(parked.challenge?.reject);
    expect(parked.expiresInMs).toBeGreaterThan(0);
  });

  it('says plainly that nobody can answer it — the B3 honesty valve', () => {
    // No REIN_APPROVER_PUBLIC_KEY in a test world, and that is the same
    // posture the public console deploys in. A parked payment with no
    // registered key is not awaiting a human; it is awaiting an expiry. The
    // panel must be able to tell an operator which of the two it is looking
    // at, the same way B1 reports `settlementsSeen === 0`.
    expect(boot.escalations.approvers).toEqual([]);
    expect(boot.escalations.recent).toEqual([]);
    expect(boot.escalations.ttlMs).toBeGreaterThan(0);
  });

  it('charges no budget while parked — an escalation is not an allowance', () => {
    // The spend ledger IS the allowance ledger, and the engine writes to it
    // only after an allow. A parked payment therefore leaves the rolling
    // window exactly where it was; the charge lands at APPROVAL time, which is
    // when the money actually moves.
    const probation = boot.breakers.find((b) => b.agentName === 'probation-agent-1')!;
    expect(probation.txCount).toBe(2);
    expect(Number(probation.sum)).toBeCloseTo(0.02);
  });

  it('refuses a grant nobody signed, and leaves the request parked', async () => {
    const parked = world.getState().escalations.pending[0]!;
    await expect(
      world.submitGrant({
        decisionId: parked.decisionId,
        intentHash: 'not-the-hash',
        verdict: 'approve',
        approverKeyId: 'apk_nobody',
        signature: 'AAAA',
      }),
    ).rejects.toThrow();
    // Fail closed: a refused submission changes nothing at all.
    const after = world.getState();
    expect(after.escalations.pending.map((p) => p.decisionId)).toContain(parked.decisionId);
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
