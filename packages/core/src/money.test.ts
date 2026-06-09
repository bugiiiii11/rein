import { describe, it, expect } from 'vitest';
import {
  DecimalString,
  compareDecimal,
  sumDecimal,
  mulDecimal,
  gt,
  lt,
  isValidDecimal,
} from './money.js';

describe('DecimalString schema', () => {
  it('accepts valid non-negative decimals', () => {
    for (const v of ['0', '5', '5.00', '0.005', '1000000.123456']) {
      expect(DecimalString.safeParse(v).success).toBe(true);
    }
  });

  it('rejects floats, negatives, and junk', () => {
    for (const v of ['-1', '1.', '.5', '1,000', '5e3', 'abc', '']) {
      expect(DecimalString.safeParse(v).success).toBe(false);
    }
    expect(isValidDecimal('-1')).toBe(false);
  });
});

describe('compareDecimal', () => {
  it('compares without float error', () => {
    expect(compareDecimal('0.1', '0.2')).toBe(-1);
    expect(compareDecimal('5.00', '5')).toBe(0);
    expect(compareDecimal('5.000001', '5')).toBe(1);
    expect(compareDecimal('10', '9.99999')).toBe(1);
  });

  it('handles differing fraction lengths', () => {
    expect(compareDecimal('1.5', '1.50')).toBe(0);
    expect(compareDecimal('1.5', '1.500001')).toBe(-1);
  });

  it('powers the gt/lt convenience helpers', () => {
    expect(gt('5.01', '5.00')).toBe(true);
    expect(lt('5.00', '5.01')).toBe(true);
    expect(gt('5.00', '5.00')).toBe(false);
  });
});

describe('sumDecimal', () => {
  it('sums exactly where floats would drift (0.1 + 0.2)', () => {
    expect(sumDecimal(['0.1', '0.2'])).toBe('0.3');
  });

  it('normalizes trailing zeros and handles the empty list', () => {
    expect(sumDecimal(['1.50', '0.50'])).toBe('2');
    expect(sumDecimal(['0.005', '0.005'])).toBe('0.01');
    expect(sumDecimal([])).toBe('0');
  });

  it('aggregates many small payments (rolling-budget use case)', () => {
    const payments = Array.from({ length: 1000 }, () => '0.001');
    expect(sumDecimal(payments)).toBe('1');
  });
});

describe('mulDecimal', () => {
  it('multiplies exactly (price-sanity: median * factor)', () => {
    expect(mulDecimal('0.01', '3')).toBe('0.03');
    expect(mulDecimal('2.5', '1.5')).toBe('3.75');
    expect(mulDecimal('0.005', '3')).toBe('0.015');
    expect(mulDecimal('100', '0')).toBe('0');
  });
});
