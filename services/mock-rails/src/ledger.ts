import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { Chain, Asset, DecimalString } from '@rein/core';

/**
 * The simulated chain. One MockLedger plays every chain at once: entries carry
 * their `chain` tag instead of living on separate ledgers, which keeps the
 * mock world to a single object.
 *
 * Crucially, ANYONE can call `transfer()` directly — that is the bypass path.
 * An agent that pays a vendor without going through the guard still leaves a
 * ledger entry, and the indexer turns that into a `shadow.spend` event.
 */
export interface TransferInput {
  chain: Chain;
  asset: Asset;
  from: string;
  to: string;
  /** Human-unit decimal amount, e.g. "0.01". */
  amount: string;
  /** Opaque settlement memo; the mock facilitator writes the intent id here. */
  memo?: string;
}

export interface LedgerEntry extends TransferInput {
  txHash: string;
  blockNumber: bigint;
  at: Date;
}

export class MockLedger {
  private readonly log: LedgerEntry[] = [];
  private readonly bus = new EventEmitter();
  private height = 0n;

  /** Append a confirmed transfer (one entry == one tx in its own block). */
  transfer(input: TransferInput): LedgerEntry {
    const entry: LedgerEntry = {
      ...input,
      chain: Chain.parse(input.chain),
      asset: Asset.parse(input.asset),
      amount: DecimalString.parse(input.amount),
      txHash: `0x${randomBytes(32).toString('hex')}`,
      blockNumber: ++this.height,
      at: new Date(),
    };
    this.log.push(entry);
    this.bus.emit('entry', entry);
    return entry;
  }

  /** All transfers, oldest first. */
  entries(): readonly LedgerEntry[] {
    return this.log;
  }

  /** Subscribe to new transfers as they confirm (what the indexer watches). */
  onEntry(handler: (entry: LedgerEntry) => void): void {
    this.bus.on('entry', handler);
  }
}
