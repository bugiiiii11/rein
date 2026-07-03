import { isValidDecimal, type GateReceipt } from '@reinconsole/core';

/**
 * Per-payer velocity limits, all sharing one rolling window. Two evidence
 * sources, deliberately different in durability:
 *
 * - `maxPayments` / `maxAmount` cap SETTLED spend and are derived from the
 *   gate's receipts at check time — on a durable store they survive restarts
 *   for free (receipts hydrate), and they never drift from revenue truth.
 * - `maxAttempts` caps PRESENTATIONS (any outcome) and lives in memory only —
 *   refused attempts leave no durable row, so this counter resets on restart.
 *   That is acceptable for what it protects against (hammering), and it keeps
 *   the port unchanged.
 *
 * Limits are gate-wide per payer (no per-route caps in v0.1). A payment
 * refused for velocity is NOT replay-burned — the same signed header may be
 * re-presented once the window clears; the refusal carries Retry-After.
 */
export interface GateVelocity {
  /** Rolling window in milliseconds. */
  windowMs: number;
  /** Max settled payments per payer inside the window (any asset). */
  maxPayments?: number;
  /**
   * Max settled decimal amount per payer inside the window, compared per
   * asset (only receipts in the incoming payment's asset count toward it).
   * Also acts as a per-payment ceiling: a single payment above it never
   * clears, and its refusal carries no Retry-After.
   */
  maxAmount?: string;
  /** Max payment presentations per payer inside the window, any outcome. */
  maxAttempts?: number;
}

/** Fail fast on misconfiguration — a silent zero-cap gate refuses everyone. */
export function validateVelocity(velocity: GateVelocity): void {
  if (!Number.isFinite(velocity.windowMs) || velocity.windowMs <= 0) {
    throw new TypeError(`velocity.windowMs must be a positive number, got ${velocity.windowMs}`);
  }
  if (
    velocity.maxPayments === undefined &&
    velocity.maxAmount === undefined &&
    velocity.maxAttempts === undefined
  ) {
    throw new TypeError('velocity needs at least one of maxPayments, maxAmount, maxAttempts');
  }
  for (const key of ['maxPayments', 'maxAttempts'] as const) {
    const value = velocity[key];
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new TypeError(`velocity.${key} must be a positive integer, got ${value}`);
    }
  }
  if (velocity.maxAmount !== undefined && !isValidDecimal(velocity.maxAmount)) {
    throw new TypeError(`velocity.maxAmount must be a decimal string, got ${JSON.stringify(velocity.maxAmount)}`);
  }
}

/** How many keys the attempt tracker holds before sweeping expired entries. */
const SWEEP_THRESHOLD = 10_000;

/**
 * In-memory sliding-window presentation counter, keyed by lowercased payer.
 * Every presentation counts, including refused ones — a payer hammering
 * mismatched payments is exactly who this exists for.
 */
export class AttemptWindow {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly windowMs: number) {}

  /** Record a presentation at `nowMs`; returns the in-window count (incl. it). */
  record(key: string, nowMs: number): number {
    if (this.hits.size >= SWEEP_THRESHOLD && !this.hits.has(key)) this.sweep(nowMs);
    const since = nowMs - this.windowMs;
    const kept = (this.hits.get(key) ?? []).filter((at) => at > since);
    kept.push(nowMs);
    this.hits.set(key, kept);
    return kept.length;
  }

  /**
   * Ms until the in-window count drops below `maxAttempts` — i.e. until enough
   * of the oldest hits expire that one more presentation would be admitted.
   */
  msUntilSlot(key: string, nowMs: number, maxAttempts: number): number {
    const since = nowMs - this.windowMs;
    const inWindow = (this.hits.get(key) ?? []).filter((at) => at > since);
    // When hit [count - maxAttempts] leaves the window, count falls to maxAttempts - 1.
    const gatingHit = inWindow[inWindow.length - maxAttempts];
    if (gatingHit === undefined) return 0;
    return Math.max(1, gatingHit + this.windowMs - nowMs);
  }

  /** Drop keys with no in-window hits (unbounded-payer protection). */
  private sweep(nowMs: number): void {
    const since = nowMs - this.windowMs;
    for (const [key, times] of this.hits) {
      const kept = times.filter((at) => at > since);
      if (kept.length === 0) this.hits.delete(key);
      else this.hits.set(key, kept);
    }
  }
}

/**
 * Receipts by `payer` (case-insensitive, EVM rule) at or after `sinceMs`,
 * oldest first — the receipt log is append-ordered and durable stores hydrate
 * it in original order, so no sort is needed.
 */
export function payerReceiptsSince(
  receipts: readonly GateReceipt[],
  payer: string,
  sinceMs: number,
): GateReceipt[] {
  const key = payer.toLowerCase();
  return receipts.filter((r) => r.payer.toLowerCase() === key && r.at.getTime() >= sinceMs);
}
