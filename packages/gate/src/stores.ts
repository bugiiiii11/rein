import type { GateReceipt } from '@rein/core';

/** Sync for in-memory stores; durable stores return a promise. */
export type MaybePromise<T> = T | Promise<T>;

/**
 * The gate's storage seam. Two consistency classes live here, split the same
 * way the engine and graph stores are:
 *
 * - **Replay slots are security state** — the gate AWAITS `burnReplay`, and a
 *   durable impl persists the burn BEFORE resolving. A payment settles only
 *   after its slot is durably burned, so a crash-and-restart cannot let the
 *   same header settle twice (the mock ledger, unlike the chain, would).
 * - **Receipts and counters are telemetry** — writes may trail behind
 *   (cache-then-persist), with `flush()` as the error channel: it drains
 *   pending writes and throws the first failure since the last flush.
 *
 * Reads are synchronous from the working set (`stats()` stays sync).
 */
export interface GateStorePort {
  /**
   * Check-and-burn a replay slot: returns false when this exact payment was
   * already presented. The check-and-set MUST happen synchronously at call
   * time so two concurrent copies of one header cannot both see it fresh;
   * a durable impl then persists the burn before resolving. Slots are never
   * released — a failed settle after the burn stays burned (deliberate:
   * the payer must re-quote).
   */
  burnReplay(key: string): MaybePromise<boolean>;
  /**
   * OPTIONAL: remove a burned slot (memory AND disk). The gate calls this in
   * exactly one situation — the rails PROVABLY never saw the payment
   * (`rails_unavailable`), so re-presenting the same header is safe once they
   * return. Stores that omit it leave the slot burned: conservative, the
   * payer re-signs instead. Never called after an ambiguous settle.
   */
  releaseReplay?(key: string): MaybePromise<void>;
  /** Record a settled payment's receipt (may trail; see flush). Note: the
   *  receipt is the ONLY durable record of a settlement — a hard crash with
   *  the tail unflushed permanently undercounts that payment's revenue. */
  appendReceipt(receipt: GateReceipt): MaybePromise<void>;
  /** Count a 402 quote served (may trail; see flush). */
  recordQuote(): MaybePromise<void>;
  /** Count a refused payment (may trail; see flush). */
  recordRefusal(): MaybePromise<void>;

  // Sync reads from the working set.
  receipts(): readonly GateReceipt[];
  quoted(): number;
  refused(): number;

  /** Durable impls: drain trailing writes, throw the first failure. */
  flush?(): Promise<void>;
}

/** In-memory gate store — the default, and the working set durable stores hydrate into. */
export class InMemoryGateStore implements GateStorePort {
  private readonly seenPayments = new Set<string>();
  private readonly receiptLog: GateReceipt[] = [];
  private quotedCount = 0;
  private refusedCount = 0;

  burnReplay(key: string): boolean {
    if (this.seenPayments.has(key)) return false;
    this.seenPayments.add(key);
    return true;
  }

  /**
   * Release a burned slot — on the port (optional) since the rails-unreachable
   * path, and still what a persist-then-cache impl uses to leave memory
   * untouched when its own INSERT fails.
   */
  releaseReplay(key: string): void {
    this.seenPayments.delete(key);
  }

  appendReceipt(receipt: GateReceipt): void {
    this.receiptLog.push(receipt);
  }

  recordQuote(): void {
    this.quotedCount += 1;
  }

  recordRefusal(): void {
    this.refusedCount += 1;
  }

  /** Hydration primitive for durable stores: set the resumed counter totals. */
  loadCounters(quoted: number, refused: number): void {
    this.quotedCount = quoted;
    this.refusedCount = refused;
  }

  receipts(): readonly GateReceipt[] {
    return this.receiptLog;
  }

  quoted(): number {
    return this.quotedCount;
  }

  refused(): number {
    return this.refusedCount;
  }
}
