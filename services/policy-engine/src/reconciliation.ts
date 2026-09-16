import { sumDecimal, type Window } from '@reinconsole/core';
import { parseWindowMs, type SettlementStorePort, type SpendStorePort } from './stores.js';

/**
 * Reconciliation: "allowed but never settled" (Phase B1).
 *
 * The engine authorizes payments; it does not make them. Between the ALLOW and
 * the money there is a gap where a payment can quietly fail — a facilitator
 * that never broadcast, a vendor that never confirmed, an agent that crashed
 * mid-flight. Nothing in the stack notices on its own: the decision chain says
 * "allowed", the rolling budget has already been charged, and the payment
 * simply never happened. This module is the join that notices.
 *
 * Two rules hold the design honest:
 *
 * 1. Reconciliation is OBSERVABILITY, never authority. It cannot deny, cannot
 *    alter a decision, and — most importantly — never un-counts the spend of
 *    an unsettled allowance. Refunding the budget would hand every agent a
 *    self-service reset: don't settle, and the envelope refills.
 * 2. A gap has an AGE, not a boolean. Under the grace period a missing
 *    settlement is a payment in flight, which is the normal state of every
 *    payment for its first seconds. Only past the grace is it evidence.
 */

/** How long an allowance may go unsettled before it counts as a gap. */
export const DEFAULT_SETTLEMENT_GRACE_MS = 60_000;
/** Default span of allowances the report covers. */
export const DEFAULT_RECONCILE_WINDOW: Window = '24h';
/** Default cap on the rows a report carries (the COUNTS stay exact). */
export const DEFAULT_RECONCILE_LIMIT = 100;

/** One allowance with no settlement behind it. */
export interface AllowanceGap {
  intentId: string;
  /** The decision that authorized it — the audit link. */
  decisionId?: string;
  agentId: string;
  host: string;
  resource: string;
  /** The amount ALLOWED. Nothing is known to have moved. */
  amount: string;
  taskId?: string;
  allowedAt: number;
  ageMs: number;
  /**
   * `in-flight` while younger than the grace period — expected, not an alarm.
   * `unsettled` once it is reached: the engine said yes and no one has seen
   * the money. The boundary itself counts as unsettled, so `graceMs: 0` means
   * exactly that — no grace at all.
   */
  state: 'in-flight' | 'unsettled';
}

export interface ReconciliationReport {
  /** The span of ALLOWANCES covered, selected by when each was allowed. */
  from: number;
  to: number;
  window: Window;
  graceMs: number;
  /** Reconcilable allowances in the window (excludes `unattributed`). */
  allowed: number;
  allowedValue: string;
  settled: number;
  /** Summed at the amounts ALLOWED, not as settled — see `settle` reports. */
  settledValue: string;
  inFlight: number;
  inFlightValue: string;
  unsettled: number;
  unsettledValue: string;
  /**
   * Allowances carrying no intent id, written before B1 existed. They cannot
   * be joined, so they are counted apart rather than reported as gaps: an
   * upgrade must not manufacture alarms out of history it cannot check.
   */
  unattributed: number;
  /**
   * Settlements this engine has EVER been told about. Zero means no reporter
   * is connected — every gap below is then an artifact of nobody looking, and
   * a console must say so instead of raising an alarm.
   */
  settlementsSeen: number;
  /** Worst first: unsettled before in-flight, oldest before newest. */
  gaps: AllowanceGap[];
  /** True when `gaps` was capped by `limit`; the counts are still exact. */
  truncated: boolean;
}

export interface ReconcileOptions {
  /** Trailing span of allowances to cover. Default 24h. */
  window?: Window;
  /** Grace before a missing settlement is a gap. Default 60s. */
  graceMs?: number;
  /** Injected clock, so the arithmetic is testable. */
  now?: number;
  /** Cap on returned rows (counts stay exact). Default 100. */
  limit?: number;
  /** Narrow to a single agent. */
  agentId?: string;
  /**
   * Narrow to the agents a caller owns. Supplied by the engine from the
   * caller's tenant scope, so a scoped report is built from owned allowances
   * only rather than filtered afterwards — a count computed over rows the
   * caller may not see would leak the other tenant's volume through the
   * totals even with the `gaps` list trimmed.
   *
   * `settlementsSeen` is the deliberate exception: it counts every settlement
   * this ENGINE was ever told about, because its job is to answer "is any
   * reporter connected at all", which is a property of the deployment rather
   * than of a tenant. Nothing about another org's payments can be read off it.
   */
  agentFilter?: (agentId: string) => boolean;
}

/**
 * Join the allowance ledger against the settlement facts.
 *
 * The unit is the INTENT, not the decision: a resolved escalation appends a
 * second decision for the same intent (S40), and one settlement settles the
 * payment however many decisions judged it. Duplicate allowances for one
 * intent id collapse to the earliest — the money only moves once.
 */
export function reconcile(
  spend: SpendStorePort,
  settlements: SettlementStorePort,
  options: ReconcileOptions = {},
): ReconciliationReport {
  const now = options.now ?? Date.now();
  const window = options.window ?? DEFAULT_RECONCILE_WINDOW;
  const graceMs = options.graceMs ?? DEFAULT_SETTLEMENT_GRACE_MS;
  const limit = options.limit ?? DEFAULT_RECONCILE_LIMIT;
  const from = now - parseWindowMs(window);

  const settledAmounts: string[] = [];
  const inFlight: AllowanceGap[] = [];
  const unsettled: AllowanceGap[] = [];
  const seenIntents = new Set<string>();
  let unattributed = 0;

  for (const rec of spend.allowancesIn(from, now)) {
    if (options.agentId !== undefined && rec.agentId !== options.agentId) continue;
    if (options.agentFilter && !options.agentFilter(rec.agentId)) continue;
    if (rec.intentId === undefined) {
      unattributed += 1;
      continue;
    }
    if (seenIntents.has(rec.intentId)) continue;
    seenIntents.add(rec.intentId);

    if (settlements.get(rec.intentId)) {
      settledAmounts.push(rec.amount);
      continue;
    }
    const ageMs = now - rec.at;
    const gap: AllowanceGap = {
      intentId: rec.intentId,
      ...(rec.decisionId !== undefined ? { decisionId: rec.decisionId } : {}),
      agentId: rec.agentId,
      host: rec.host,
      resource: rec.resource,
      amount: rec.amount,
      ...(rec.taskId !== undefined ? { taskId: rec.taskId } : {}),
      allowedAt: rec.at,
      ageMs,
      // Inclusive: grace that has fully elapsed is spent. Strict `>` would
      // hand every allowance one millisecond of grace it was never granted,
      // so `graceMs: 0` -- "no grace, count everything" -- could not be said.
      state: ageMs >= graceMs ? 'unsettled' : 'in-flight',
    };
    (gap.state === 'unsettled' ? unsettled : inFlight).push(gap);
  }

  // Oldest first inside each group: the longest-standing gap is the one worth
  // a human's attention, and it is the one a truncated list must not drop.
  const byAge = (a: AllowanceGap, b: AllowanceGap) => a.allowedAt - b.allowedAt;
  unsettled.sort(byAge);
  inFlight.sort(byAge);
  const gaps = [...unsettled, ...inFlight];

  return {
    from,
    to: now,
    window,
    graceMs,
    allowed: settledAmounts.length + gaps.length,
    allowedValue: sumDecimal([...settledAmounts, ...gaps.map((g) => g.amount)]),
    settled: settledAmounts.length,
    settledValue: sumDecimal(settledAmounts),
    inFlight: inFlight.length,
    inFlightValue: sumDecimal(inFlight.map((g) => g.amount)),
    unsettled: unsettled.length,
    unsettledValue: sumDecimal(unsettled.map((g) => g.amount)),
    unattributed,
    settlementsSeen: settlements.count(),
    gaps: gaps.slice(0, limit),
    truncated: gaps.length > limit,
  };
}
