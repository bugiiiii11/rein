import { z } from 'zod';
import { AgentId } from './ids.js';
import { Window } from './policy.js';

/**
 * Dead-man monitoring: the alarm for an agent that stopped (Phase B2).
 *
 * Every other control in Rein answers "should this payment happen?". This one
 * answers the question nothing else in the stack asks: an agent that has gone
 * quiet raises no intent, breaks no budget, and trips no breaker — it simply
 * disappears, and a control plane watching only for bad payments will report
 * a perfectly clean month while the work silently stopped being done. (Flash
 * lost four detectors this way, none of which announced anything.)
 *
 * Three rules hold the design honest, and each is the direct mirror of a rule
 * B1 already established:
 *
 * 1. An expectation is DECLARED, never inferred. Most agents are episodic:
 *    they run when there is work. Silence is only evidence for an agent
 *    somebody said should be periodic, so an unwatched agent has no liveness
 *    state at all — the same rule as `taskBudget`, which never fires on an
 *    intent that carries no task id.
 * 2. Silence has an AGE, not a boolean — `late` before `missing` — exactly as
 *    a missing settlement is `in-flight` before it is `unsettled`.
 * 3. The engine never alarms about silence it did not witness. An engine that
 *    was down cannot tell a dead agent from its own outage, so a silence
 *    older than this process reads `unknown` until the process has been up
 *    long enough to certify it. B1 refuses to manufacture gaps out of records
 *    it cannot join; this refuses to manufacture alarms out of downtime.
 *
 * Liveness is observability and carries no authority whatsoever: it cannot
 * deny, escalate, freeze, or alter any decision. A missing agent is news for
 * a human, not an input to policy.
 */

/** How the engine came to know an agent was alive. */
export const LivenessSource = z.enum([
  /** It submitted an intent — ANY outcome, including a denial. */
  'intent',
  /** It reported in explicitly, having nothing to buy. */
  'heartbeat',
]);
export type LivenessSource = z.infer<typeof LivenessSource>;

/** Default slack past the interval before silence becomes an alarm. */
export const DEFAULT_LIVENESS_GRACE_MS = 60_000;

/**
 * "This agent is supposed to check in at least this often."
 *
 * `graceMs` is what keeps a jittery-but-healthy agent out of the alert
 * channel: an agent on a 15m cadence that lands at 15m04s is not a dead agent,
 * and an alarm that cries at every wobble is one an operator learns to ignore
 * — which is the failure mode that loses the detector nobody was watching.
 */
export const LivenessExpectation = z.object({
  agentId: AgentId,
  /** Longest silence still considered normal, e.g. '15m'. */
  interval: Window,
  /** Extra slack past `interval` before the silence is an alarm. */
  graceMs: z.number().int().nonnegative().default(DEFAULT_LIVENESS_GRACE_MS),
  /**
   * When watching began. An agent that has NEVER been seen is measured from
   * here, so a watch on an agent that never starts does raise an alarm — a
   * detector that never came up is exactly as dead as one that stopped.
   */
  since: z.coerce.date(),
  /** What this agent is supposed to be doing, shown beside the alarm. */
  note: z.string().max(200).optional(),
});
export type LivenessExpectation = z.infer<typeof LivenessExpectation>;

/** The registration payload; the engine stamps `since`. */
export const LivenessWatchInput = LivenessExpectation.omit({ since: true }).extend({
  graceMs: z.number().int().nonnegative().optional(),
});
export type LivenessWatchInput = z.input<typeof LivenessWatchInput>;

/**
 * An out-of-band "I am alive" from an agent with nothing to buy.
 *
 * The engine sees every intent, so a spending agent needs no heartbeat at all.
 * This exists for the agent that is working and simply not paying for
 * anything — without it, a dead-man alarm is really a no-spend alarm, and it
 * would page a human every time an agent had a quiet afternoon.
 *
 * It authorizes nothing. The only thing a heartbeat can change is a row in the
 * liveness report; it cannot lift a breaker, a budget, or a freeze.
 */
export const Heartbeat = z.object({
  agentId: AgentId,
  /** When the agent was alive. Defaults to arrival time. */
  at: z.coerce.date().optional(),
  /** Free-form note from the reporter, e.g. "poll cycle 41 ok". */
  note: z.string().max(200).optional(),
});
export type Heartbeat = z.infer<typeof Heartbeat>;

/**
 * Where an agent stands against its expectation.
 *
 * - `alive`   — seen within the interval.
 * - `late`    — past the interval, inside the grace. Not yet news.
 * - `missing` — past both, and this process watched it happen. THE alarm.
 * - `unknown` — past both, but the engine has not been up long enough to have
 *               witnessed the silence. Not an alarm: an engine that restarted
 *               five minutes ago knows nothing about the last three days.
 */
export const LivenessStatus = z.enum(['alive', 'late', 'missing', 'unknown']);
export type LivenessStatus = z.infer<typeof LivenessStatus>;
