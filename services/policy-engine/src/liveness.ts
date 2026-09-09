import {
  DEFAULT_LIVENESS_GRACE_MS,
  LivenessExpectation,
  type LivenessSource,
  type LivenessStatus,
  type LivenessWatchInput,
} from '@reinconsole/core';
import { parseWindowMs, type MaybePromise } from './stores.js';

/**
 * Dead-man monitoring (Phase B2): the alarm for an agent that stopped.
 *
 * See the design rules in `@reinconsole/core/liveness.ts`. The short version:
 * an expectation is declared rather than inferred, silence has an age rather
 * than a boolean, and the engine never alarms about silence it did not
 * witness. Nothing here carries authority — an alarm is news for a human, and
 * no part of evaluation reads any of it.
 */

/**
 * A liveness call the engine cannot serve — asking about a monitor that does
 * not exist. Its own type so the HTTP layer answers 404 instead of a 500: a
 * deployment with no monitor is a configuration, not a fault.
 */
export class LivenessError extends Error {
  constructor(
    readonly status: 404,
    readonly code: 'liveness_disabled',
    message: string,
  ) {
    super(message);
    this.name = 'LivenessError';
  }
}

/** One watched agent: the expectation, the last sighting, the alarm's state. */
export interface LivenessRecord {
  expectation: LivenessExpectation;
  /** Epoch ms of the last sighting; absent when never seen. */
  lastSeenAt?: number;
  lastSource?: LivenessSource;
  /**
   * When the CURRENT silence was announced, if it was. Durable, and cleared by
   * the next sighting: an alarm must fire once per silence, not once per
   * sweep, and a restart that forgot this would re-announce every dead agent
   * an operator has already been told about (the S41 breaker-floor lesson).
   */
  alertedAt?: number;
}

/**
 * Where expectations and sightings live.
 *
 * Sightings are LATEST-wins, the opposite of settlements' first-wins rule: a
 * settlement is a fact about one payment that happened once, while a sighting
 * is evidence of ongoing life, and the freshest evidence is the one that
 * matters.
 */
export interface LivenessStorePort {
  /** Upsert an expectation. Sightings and alarm state survive a re-watch. */
  watch(expectation: LivenessExpectation): MaybePromise<void>;
  /** Stop watching. Forgets the sightings too — the agent is unwatched. */
  unwatch(agentId: string): MaybePromise<void>;
  get(agentId: string): LivenessRecord | undefined;
  list(): LivenessRecord[];
  /** Record a sighting. Ignored for an agent nobody is watching. */
  seen(agentId: string, at: number, source: LivenessSource): MaybePromise<void>;
  /** Set (or, with `undefined`, clear) the announced-at stamp. */
  setAlerted(agentId: string, at: number | undefined): MaybePromise<void>;
}

export class InMemoryLivenessStore implements LivenessStorePort {
  private readonly records = new Map<string, LivenessRecord>();

  watch(expectation: LivenessExpectation): void {
    const existing = this.records.get(expectation.agentId);
    // Re-watching keeps the history: changing an interval is a config edit,
    // not a claim that the agent just checked in.
    this.records.set(expectation.agentId, { ...existing, expectation });
  }

  unwatch(agentId: string): void {
    this.records.delete(agentId);
  }

  get(agentId: string): LivenessRecord | undefined {
    return this.records.get(agentId);
  }

  list(): LivenessRecord[] {
    return [...this.records.values()];
  }

  seen(agentId: string, at: number, source: LivenessSource): void {
    const rec = this.records.get(agentId);
    if (!rec) return;
    // Latest wins, and an out-of-order report cannot walk the clock backwards.
    if (rec.lastSeenAt !== undefined && rec.lastSeenAt >= at) return;
    this.records.set(agentId, { ...rec, lastSeenAt: at, lastSource: source });
  }

  setAlerted(agentId: string, at: number | undefined): void {
    const rec = this.records.get(agentId);
    if (!rec) return;
    const { alertedAt: _dropped, ...rest } = rec;
    this.records.set(agentId, at === undefined ? rest : { ...rest, alertedAt: at });
  }
}

/** Where an agent stands against its expectation, at one instant. */
export interface LivenessState {
  agentId: string;
  expectation: LivenessExpectation;
  /** Epoch ms of the last sighting; absent when the agent was never seen. */
  lastSeenAt?: number;
  lastSource?: LivenessSource;
  /**
   * Start of the current silence: the last sighting, or — for an agent never
   * seen at all — the moment watching began. A detector that never came up is
   * exactly as dead as one that stopped, so both are measured the same way.
   */
  silentSince: number;
  silentMs: number;
  /** When the silence stops being normal (`alive` -> `late`). */
  dueAt: number;
  /**
   * When the silence may be ALARMED, floored by the engine's own start.
   *
   * The same trick as a breaker's counting floor (A3): the later of two clocks
   * wins. There, a signed reset raises the floor under a window; here, this
   * process's boot raises the floor under a silence it was not present for.
   * One `max()` is the whole of rule 3 — an engine that restarted five minutes
   * ago cannot certify three days of quiet, and must not page anyone about it.
   */
  overdueAt: number;
  status: LivenessStatus;
  /** When the current silence was announced, if it was. */
  alertedAt?: number;
}

/** A raised alarm: a watched agent has been quiet past its envelope. */
export interface LivenessAlert {
  agentId: string;
  expectation: LivenessExpectation;
  lastSeenAt?: number;
  lastSource?: LivenessSource;
  silentMs: number;
  /** When the alarm was raised. */
  at: number;
}

/** An agent that was announced missing and has since been seen again. */
export interface LivenessRecovery {
  agentId: string;
  /** How long the silence lasted, end to end. */
  silentMs: number;
  source: LivenessSource;
  at: number;
}

/**
 * Where an alarm is delivered.
 *
 * The same one-way contract as {@link ApprovalChannel}, and here it holds for
 * free: an alarm has nothing to sign, so there is no verdict a channel could
 * be tricked into asserting. What must NOT appear is the other direction — a
 * reply, button, or command that silences an alarm. Silence is ended by the
 * agent being seen again, and by nothing else; an acknowledge button would let
 * whoever holds the bot token quiet the one alarm that matters.
 */
export interface AlertChannel {
  readonly name: string;
  alert(alert: LivenessAlert): MaybePromise<void>;
}

export interface LivenessMonitorOptions {
  store?: LivenessStorePort;
  channels?: AlertChannel[];
  /** Injected clock, so silence arithmetic is testable without waiting. */
  now?: () => number;
  /**
   * When this engine started watching — the floor under every silence (see
   * {@link LivenessState.overdueAt}). Defaults to construction time, which on
   * a durable deployment is process boot.
   */
  startedAt?: number;
  /** Called when a channel throws, so a failed alarm is never silent. */
  onAlertError?: (channel: string, error: unknown) => void;
  /**
   * Called when a SIGHTING could not be written. Sightings ride the evaluate
   * path, and liveness is telemetry: a broken liveness table must never turn a
   * payment into an error, so {@link LivenessMonitor.seen} swallows the write
   * failure and reports it here. The cost of the swallow is a false alarm
   * later, which is exactly the kind of thing this hook exists to precede.
   */
  onSightingError?: (agentId: string, error: unknown) => void;
}

export class LivenessMonitor {
  private readonly store: LivenessStorePort;
  private readonly channels: AlertChannel[];
  private readonly now: () => number;
  private readonly onAlertError: ((channel: string, error: unknown) => void) | undefined;
  private readonly onSightingError: ((agentId: string, error: unknown) => void) | undefined;
  /** The witness floor. Read by every state computation; never moves. */
  readonly startedAt: number;

  constructor(options: LivenessMonitorOptions = {}) {
    this.store = options.store ?? new InMemoryLivenessStore();
    this.channels = options.channels ?? [];
    this.now = options.now ?? Date.now;
    this.startedAt = options.startedAt ?? this.now();
    this.onAlertError = options.onAlertError;
    this.onSightingError = options.onSightingError;
  }

  /** Start watching an agent (or update an existing expectation). */
  async watch(input: LivenessWatchInput): Promise<LivenessExpectation> {
    const existing = this.store.get(input.agentId)?.expectation;
    const expectation = LivenessExpectation.parse({
      ...input,
      graceMs: input.graceMs ?? existing?.graceMs ?? DEFAULT_LIVENESS_GRACE_MS,
      // A re-watch keeps the original start: editing an interval must not
      // hand a silent agent a fresh clock and quietly clear its alarm.
      since: existing?.since ?? new Date(this.now()),
    });
    await this.store.watch(expectation);
    return expectation;
  }

  async unwatch(agentId: string): Promise<boolean> {
    if (!this.store.get(agentId)) return false;
    await this.store.unwatch(agentId);
    return true;
  }

  /** Whether anybody expects this agent to check in. */
  watches(agentId: string): boolean {
    return this.store.get(agentId) !== undefined;
  }

  /**
   * Record that the agent was alive.
   *
   * Returns the recovery when this sighting ends an ANNOUNCED silence, so the
   * caller can say so. A silence nobody was told about needs no all-clear.
   * Sightings for unwatched agents are dropped: with no expectation there is
   * nothing to be late for, and the hot path should not pay for a write that
   * can never be read.
   */
  async seen(
    agentId: string,
    source: LivenessSource,
    at: number = this.now(),
  ): Promise<LivenessRecovery | undefined> {
    const before = this.store.get(agentId);
    if (!before) return undefined;
    // A sighting older than the last one is not news, and must not clear an
    // alarm: backdating a heartbeat would otherwise silence a dead agent.
    if (before.lastSeenAt !== undefined && before.lastSeenAt >= at) return undefined;
    try {
      await this.store.seen(agentId, at, source);
      if (before.alertedAt === undefined) return undefined;
      await this.store.setAlerted(agentId, undefined);
    } catch (error) {
      // Telemetry must never alter a payment outcome: this runs on the
      // evaluate path, and an agent that is demonstrably alive must not have
      // its intent fail because the liveness table did.
      this.onSightingError?.(agentId, error);
      return undefined;
    }
    const silentSince = before.lastSeenAt ?? before.expectation.since.getTime();
    return { agentId, silentMs: Math.max(0, at - silentSince), source, at };
  }

  state(agentId: string, now: number = this.now()): LivenessState | undefined {
    const rec = this.store.get(agentId);
    return rec ? this.project(rec, now) : undefined;
  }

  /** Every watched agent, worst first (missing before late before alive). */
  states(now: number = this.now()): LivenessState[] {
    const rank: Record<LivenessStatus, number> = { missing: 0, unknown: 1, late: 2, alive: 3 };
    return this.store
      .list()
      .map((rec) => this.project(rec, now))
      .sort((a, b) => rank[a.status] - rank[b.status] || b.silentMs - a.silentMs);
  }

  /**
   * Raise every newly-missing agent through the channels, once each.
   *
   * This is the half of B2 that needs a clock: every other control is driven
   * by something happening, and this one is driven by something not happening,
   * so nothing will call the engine on its behalf. Correctness does not depend
   * on the sweep's cadence — {@link states} computes the same answer at any
   * instant — the sweep is only what makes an alarm ARRIVE.
   */
  async sweep(now: number = this.now()): Promise<LivenessAlert[]> {
    const raised: LivenessAlert[] = [];
    for (const rec of this.store.list()) {
      const state = this.project(rec, now);
      if (state.status !== 'missing' || state.alertedAt !== undefined) continue;
      await this.store.setAlerted(state.agentId, now);
      const alert: LivenessAlert = {
        agentId: state.agentId,
        expectation: state.expectation,
        ...(state.lastSeenAt !== undefined ? { lastSeenAt: state.lastSeenAt } : {}),
        ...(state.lastSource !== undefined ? { lastSource: state.lastSource } : {}),
        silentMs: state.silentMs,
        at: now,
      };
      raised.push(alert);
      await this.deliver(alert);
    }
    return raised;
  }

  private project(rec: LivenessRecord, now: number): LivenessState {
    const { expectation } = rec;
    const intervalMs = parseWindowMs(expectation.interval);
    const silentSince = rec.lastSeenAt ?? expectation.since.getTime();
    const dueAt = silentSince + intervalMs;
    const alarmMs = intervalMs + expectation.graceMs;
    // The witness floor — see LivenessState.overdueAt.
    const overdueAt = Math.max(silentSince, this.startedAt) + alarmMs;
    const status: LivenessStatus =
      now <= dueAt
        ? 'alive'
        : now > overdueAt
          ? 'missing'
          : // Past its own envelope but not past the floor: the silence is real
            // and the engine simply was not here for it. Saying `late` would
            // claim a freshness this process cannot vouch for.
            now > silentSince + alarmMs
            ? 'unknown'
            : 'late';
    return {
      agentId: expectation.agentId,
      expectation,
      ...(rec.lastSeenAt !== undefined ? { lastSeenAt: rec.lastSeenAt } : {}),
      ...(rec.lastSource !== undefined ? { lastSource: rec.lastSource } : {}),
      silentSince,
      silentMs: Math.max(0, now - silentSince),
      dueAt,
      overdueAt,
      status,
      ...(rec.alertedAt !== undefined ? { alertedAt: rec.alertedAt } : {}),
    };
  }

  private async deliver(alert: LivenessAlert): Promise<void> {
    for (const channel of this.channels) {
      try {
        await channel.alert(alert);
      } catch (error) {
        // A channel that is down must not cost us the alarm's bookkeeping:
        // the agent stays announced, and the operator finds it in the console.
        this.onAlertError?.(channel.name, error);
      }
    }
  }
}
