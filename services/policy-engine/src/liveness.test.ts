import { describe, it, expect } from 'vitest';
import { newId, type ReinEvent } from '@reinconsole/core';
import { PolicyEngine } from './engine.js';
import { LivenessMonitor, type AlertChannel, type LivenessAlert } from './liveness.js';

/**
 * B2 — dead-man / minimum-activity monitoring.
 *
 * The invariants these tests exist to defend:
 *   - an expectation is DECLARED, never inferred: an unwatched agent has no
 *     liveness state, and a heartbeat for one is refused rather than accepted
 *     into a void;
 *   - ANY intent is a sighting, including a denied one — an agent that is
 *     blocked is alive, and a different alarm's problem;
 *   - silence has an age (`late` before `missing`), and the alarm fires ONCE
 *     per silence, not once per sweep;
 *   - the engine never alarms about silence it did not witness: a restart
 *     cannot tell a dead agent from its own downtime, and says `unknown`;
 *   - liveness carries no authority — nothing about a decision changes when an
 *     agent is missing, and a heartbeat authorizes nothing.
 */

const MINUTE = 60_000;

function baseIntent(agentId: string, amount = '1.00') {
  return {
    agentId,
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount,
    asset: 'USDC' as const,
    chain: 'base' as const,
  };
}

/** A channel that records what it was asked to announce. */
class RecordingChannel implements AlertChannel {
  readonly name = 'recording';
  readonly alerts: LivenessAlert[] = [];
  alert(alert: LivenessAlert): void {
    this.alerts.push(alert);
  }
}

function monitorAt(startedAt: number, channels: AlertChannel[] = []): LivenessMonitor {
  return new LivenessMonitor({ startedAt, channels, now: () => startedAt });
}

async function watchedEngine(startedAt: number, channels: AlertChannel[] = []) {
  const liveness = monitorAt(startedAt, channels);
  const engine = new PolicyEngine({ liveness });
  await engine.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
  return { engine, liveness };
}

describe('watching is declared, never inferred', () => {
  it('reports nothing for an agent nobody watches', async () => {
    const { engine } = await watchedEngine(0);
    const agentId = newId('agt');
    await engine.evaluateIntent(baseIntent(agentId));
    // An episodic agent is not late for anything: silence is only evidence
    // about an agent somebody said should be periodic.
    expect(engine.livenessStates()).toEqual([]);
  });

  it('refuses a heartbeat for an unwatched agent', async () => {
    const { engine } = await watchedEngine(0);
    // The reporter must learn it is not being monitored — believing you are
    // watched when you are not is the exact failure B2 exists to prevent.
    expect(await engine.heartbeat({ agentId: newId('agt') })).toBeUndefined();
  });

  it('refuses to watch at all when no monitor is configured', async () => {
    const engine = new PolicyEngine();
    await expect(engine.watchLiveness({ agentId: newId('agt'), interval: '15m' })).rejects.toThrow(
      /no liveness monitor/,
    );
    expect(engine.livenessStates()).toEqual([]);
  });

  it('measures a never-seen agent from when watching began', async () => {
    const t0 = 1_000_000;
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0 });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '15m', graceMs: MINUTE });
    // A detector that never came up is exactly as dead as one that stopped.
    expect(liveness.state(agentId, t0 + 5 * MINUTE)?.status).toBe('alive');
    expect(liveness.state(agentId, t0 + 20 * MINUTE)?.status).toBe('missing');
  });
});

describe('every intent is a sighting', () => {
  it('counts a DENIED intent as activity', async () => {
    const t0 = 2_000_000;
    const liveness = monitorAt(t0);
    // The engine reads its OWN clock for the sighting, never the intent's
    // `createdAt` -- a caller that could stamp its own sighting could keep a
    // dead agent looking alive forever by dating one intent into next week.
    const clock = { now: t0 };
    const engine = new PolicyEngine({ liveness, now: () => clock.now });
    const agentId = newId('agt');
    await engine.addPolicy({
      policyId: 'pol_deny',
      rules: [{ id: 'no', deny: { amountGt: '0.01' } }],
      default: 'allow',
    });
    await liveness.watch({ agentId, interval: '15m', graceMs: MINUTE });

    const at = t0 + 5 * MINUTE;
    clock.now = at;
    const { decision } = await engine.evaluateIntent(baseIntent(agentId, '5.00'));
    expect(decision.outcome).toBe('deny');

    // An agent hammering a wall is alive. Treating a denial as silence would
    // make a policy change double as a dead-man alarm, and would report a
    // hard-blocked agent as dead — the wrong alarm, with the wrong remedy.
    const state = liveness.state(agentId, at);
    expect(state?.lastSeenAt).toBe(at);
    expect(state?.lastSource).toBe('intent');
    expect(state?.status).toBe('alive');
  });

  it('takes an explicit heartbeat from an agent with nothing to buy', async () => {
    const t0 = 3_000_000;
    const { engine, liveness } = await watchedEngine(t0);
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '15m', graceMs: MINUTE });

    const state = await engine.heartbeat({ agentId, at: new Date(t0 + 10 * MINUTE) });
    expect(state?.lastSource).toBe('heartbeat');
    // Without this, a dead-man alarm is really a no-spend alarm, and a quiet
    // afternoon pages a human.
    expect(liveness.state(agentId, t0 + 20 * MINUTE)?.status).toBe('alive');
  });

  it('ignores a backdated sighting, so an alarm cannot be talked down', async () => {
    const t0 = 4_000_000;
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0 });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '15m', graceMs: MINUTE });
    await liveness.seen(agentId, 'intent', t0 + 10 * MINUTE);

    await liveness.seen(agentId, 'heartbeat', t0 + 2 * MINUTE);
    expect(liveness.state(agentId, t0 + 10 * MINUTE)?.lastSeenAt).toBe(t0 + 10 * MINUTE);
  });
});

describe('silence has an age', () => {
  it('goes alive -> late -> missing, with grace between', async () => {
    const t0 = 5_000_000;
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0 });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '15m', graceMs: 2 * MINUTE });
    await liveness.seen(agentId, 'intent', t0);

    expect(liveness.state(agentId, t0 + 14 * MINUTE)?.status).toBe('alive');
    // Inside the grace: an agent on a 15m cadence landing at 15m04s is not a
    // dead agent, and an alarm that cries at every wobble gets ignored.
    expect(liveness.state(agentId, t0 + 16 * MINUTE)?.status).toBe('late');
    expect(liveness.state(agentId, t0 + 18 * MINUTE)?.status).toBe('missing');
  });

  it('exposes when the silence becomes news', async () => {
    const t0 = 6_000_000;
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0 });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '10m', graceMs: MINUTE });
    await liveness.seen(agentId, 'intent', t0 + MINUTE);

    const state = liveness.state(agentId, t0 + 2 * MINUTE);
    expect(state?.dueAt).toBe(t0 + 11 * MINUTE);
    expect(state?.overdueAt).toBe(t0 + 12 * MINUTE);
  });
});

describe('the alarm fires once per silence', () => {
  it('announces a missing agent exactly once across sweeps', async () => {
    const t0 = 7_000_000;
    const channel = new RecordingChannel();
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0, channels: [channel] });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '5m', graceMs: MINUTE, note: 'price poller' });
    await liveness.seen(agentId, 'intent', t0);

    expect(await liveness.sweep(t0 + 3 * MINUTE)).toHaveLength(0);
    expect(await liveness.sweep(t0 + 10 * MINUTE)).toHaveLength(1);
    expect(await liveness.sweep(t0 + 20 * MINUTE)).toHaveLength(0);
    expect(channel.alerts).toHaveLength(1);
    expect(channel.alerts[0]?.expectation.note).toBe('price poller');
    expect(channel.alerts[0]?.silentMs).toBe(10 * MINUTE);
  });

  it('re-arms after the agent is seen again, and reports the recovery', async () => {
    const t0 = 8_000_000;
    const channel = new RecordingChannel();
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0, channels: [channel] });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '5m', graceMs: 0 });
    await liveness.seen(agentId, 'intent', t0);
    await liveness.sweep(t0 + 10 * MINUTE);

    const recovery = await liveness.seen(agentId, 'heartbeat', t0 + 11 * MINUTE);
    expect(recovery?.silentMs).toBe(11 * MINUTE);
    expect(liveness.state(agentId, t0 + 11 * MINUTE)?.alertedAt).toBeUndefined();

    // A second death is news again — the alarm is per silence, not per agent.
    expect(await liveness.sweep(t0 + 30 * MINUTE)).toHaveLength(1);
    expect(channel.alerts).toHaveLength(2);
  });

  it('stays silent about a silence nobody was told about', async () => {
    const t0 = 9_000_000;
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0 });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '5m', graceMs: 0 });
    await liveness.seen(agentId, 'intent', t0);
    // Late, but never announced: an all-clear for an alarm nobody heard is
    // noise, so `seen` reports no recovery.
    expect(await liveness.seen(agentId, 'intent', t0 + 6 * MINUTE)).toBeUndefined();
  });

  it('keeps the alarm raised when a channel throws', async () => {
    const t0 = 10_000_000;
    const failures: string[] = [];
    const broken: AlertChannel = {
      name: 'broken',
      alert() {
        throw new Error('telegram down');
      },
    };
    const liveness = new LivenessMonitor({
      startedAt: t0,
      now: () => t0,
      channels: [broken],
      onAlertError: (channel) => failures.push(channel),
    });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '5m', graceMs: 0 });
    await liveness.seen(agentId, 'intent', t0);

    expect(await liveness.sweep(t0 + 10 * MINUTE)).toHaveLength(1);
    expect(failures).toEqual(['broken']);
    // Bookkeeping stands: the operator finds it in the console rather than
    // being told twice when the channel comes back.
    expect(await liveness.sweep(t0 + 11 * MINUTE)).toHaveLength(0);
  });
});

describe('the engine never alarms about silence it did not witness', () => {
  it('reads a pre-restart silence as unknown, not missing', async () => {
    const died = 11_000_000;
    // The agent went quiet, then the engine restarted three days later.
    const bootedAt = died + 3 * 86_400_000;
    const liveness = new LivenessMonitor({ startedAt: bootedAt, now: () => bootedAt });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '15m', graceMs: MINUTE });
    await liveness.seen(agentId, 'intent', died);

    const fresh = liveness.state(agentId, bootedAt + MINUTE);
    expect(fresh?.status).toBe('unknown');
    expect(fresh?.silentMs).toBeGreaterThan(3 * 86_400_000);
    // ...and only once the engine has been up longer than the envelope does
    // the silence become this process's to certify.
    expect(liveness.state(agentId, bootedAt + 17 * MINUTE)?.status).toBe('missing');
  });

  it('raises nothing on the sweep while the silence is unwitnessed', async () => {
    const bootedAt = 12_000_000;
    const channel = new RecordingChannel();
    const liveness = new LivenessMonitor({
      startedAt: bootedAt,
      now: () => bootedAt,
      channels: [channel],
    });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '15m', graceMs: MINUTE });
    await liveness.seen(agentId, 'intent', bootedAt - 86_400_000);

    // A restart must not page a human about every agent at once — that alarm
    // is about the engine, and it is the storm that gets a dead-man muted.
    expect(await liveness.sweep(bootedAt + 5 * MINUTE)).toHaveLength(0);
    expect(await liveness.sweep(bootedAt + 17 * MINUTE)).toHaveLength(1);
  });
});

describe('liveness carries no authority', () => {
  it('does not change what a missing agent is allowed to do', async () => {
    const t0 = 13_000_000;
    const { engine, liveness } = await watchedEngine(t0);
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '1m', graceMs: 0 });
    await liveness.seen(agentId, 'intent', t0);
    await liveness.sweep(t0 + 10 * MINUTE);
    expect(liveness.state(agentId, t0 + 10 * MINUTE)?.status).toBe('missing');

    // The agent comes back with a payment. A dead-man alarm is news, not a
    // gate: it cannot deny, escalate, or hold the first intent back.
    const { decision } = await engine.evaluateIntent(baseIntent(agentId));
    expect(decision.outcome).toBe('allow');
    expect(decision.matchedRules).not.toContain('liveness');
  });

  it('emits the alarm and the recovery on the event bus', async () => {
    const t0 = 14_000_000;
    const { engine, liveness } = await watchedEngine(t0);
    const events: ReinEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '5m', graceMs: 0, note: 'nightly sweep' });
    await liveness.seen(agentId, 'intent', t0);

    await engine.sweepLiveness(t0 + 10 * MINUTE);
    const missing = events.find((e) => e.type === 'liveness.missing');
    expect(missing).toMatchObject({ agentId, silentMs: 10 * MINUTE });

    await engine.heartbeat({ agentId, at: new Date(t0 + 11 * MINUTE) });
    expect(events.find((e) => e.type === 'liveness.recovered')).toMatchObject({
      agentId,
      source: 'heartbeat',
    });
  });

  it('never lets a failed sighting write break a payment', async () => {
    const t0 = 15_000_000;
    const errors: string[] = [];
    const agentId = newId('agt');
    const liveness = new LivenessMonitor({
      startedAt: t0,
      now: () => t0,
      onSightingError: (id) => errors.push(id),
    });
    await liveness.watch({ agentId, interval: '5m' });
    // A liveness table that refuses writes is a telemetry outage, and
    // telemetry must never alter a payment outcome.
    const store = liveness as unknown as { store: { seen: () => never } };
    store.store.seen = () => {
      throw new Error('disk full');
    };

    const engine = new PolicyEngine({ liveness });
    await engine.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    const { decision } = await engine.evaluateIntent({
      ...baseIntent(agentId),
    });
    expect(decision.outcome).toBe('allow');
    expect(errors).toEqual([agentId]);
  });
});

describe('expectations are configuration', () => {
  it('keeps sightings and the original clock across a re-watch', async () => {
    const t0 = 16_000_000;
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0 });
    const agentId = newId('agt');
    const first = await liveness.watch({ agentId, interval: '5m', graceMs: MINUTE });
    await liveness.seen(agentId, 'intent', t0 + MINUTE);

    const second = await liveness.watch({ agentId, interval: '1h' });
    // Editing an interval must not hand a silent agent a fresh clock, which
    // would let a widened interval quietly clear an alarm.
    expect(second.since.getTime()).toBe(first.since.getTime());
    expect(second.graceMs).toBe(MINUTE);
    expect(liveness.state(agentId, t0 + 2 * MINUTE)?.lastSeenAt).toBe(t0 + MINUTE);
  });

  it('forgets an agent that is unwatched', async () => {
    const t0 = 17_000_000;
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0 });
    const agentId = newId('agt');
    await liveness.watch({ agentId, interval: '5m' });
    expect(await liveness.unwatch(agentId)).toBe(true);
    expect(await liveness.unwatch(agentId)).toBe(false);
    expect(liveness.states(t0 + 86_400_000)).toEqual([]);
  });

  it('orders the report worst first', async () => {
    const t0 = 18_000_000;
    const liveness = new LivenessMonitor({ startedAt: t0, now: () => t0 });
    const dead = newId('agt');
    const late = newId('agt');
    const fine = newId('agt');
    for (const agentId of [fine, dead, late]) {
      await liveness.watch({ agentId, interval: '10m', graceMs: 2 * MINUTE });
    }
    await liveness.seen(dead, 'intent', t0);
    await liveness.seen(late, 'intent', t0 + 10 * MINUTE);
    await liveness.seen(fine, 'intent', t0 + 20 * MINUTE);

    const order = liveness.states(t0 + 21 * MINUTE).map((s) => s.status);
    expect(order).toEqual(['missing', 'late', 'alive']);
  });
});
