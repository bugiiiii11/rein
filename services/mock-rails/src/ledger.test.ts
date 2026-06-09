import { describe, it, expect } from 'vitest';
import { MockLedger, type LedgerEntry, type TransferInput } from './ledger.js';

const transfer = (overrides: Partial<TransferInput> = {}): TransferInput => ({
  chain: 'base',
  asset: 'USDC',
  from: '0xAGENT',
  to: '0xVENDOR',
  amount: '0.01',
  ...overrides,
});

describe('MockLedger', () => {
  it('appends transfers with unique tx hashes and increasing block numbers', () => {
    const ledger = new MockLedger();
    const first = ledger.transfer(transfer());
    const second = ledger.transfer(transfer({ amount: '0.02', memo: 'int_x' }));

    expect(first.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(first.txHash).not.toBe(second.txHash);
    expect(first.blockNumber).toBe(1n);
    expect(second.blockNumber).toBe(2n);
    expect(second.memo).toBe('int_x');
    expect(ledger.entries()).toEqual([first, second]);
  });

  it('notifies subscribers as transfers confirm', () => {
    const ledger = new MockLedger();
    const seen: LedgerEntry[] = [];
    ledger.onEntry((entry) => seen.push(entry));

    const entry = ledger.transfer(transfer());

    expect(seen).toEqual([entry]);
  });

  it('rejects malformed amounts', () => {
    const ledger = new MockLedger();
    expect(() => ledger.transfer(transfer({ amount: '-1' }))).toThrow();
    expect(() => ledger.transfer(transfer({ amount: '1,5' }))).toThrow();
  });

  it('rejects unknown chains and assets', () => {
    const ledger = new MockLedger();
    expect(() => ledger.transfer(transfer({ chain: 'arbitrum' as never }))).toThrow();
    expect(() => ledger.transfer(transfer({ asset: 'DOGE' as never }))).toThrow();
  });
});
