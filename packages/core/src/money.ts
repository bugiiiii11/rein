import { z } from 'zod';

/**
 * Monetary amounts in Rein are always non-negative **decimal strings**, never
 * floats. Float arithmetic silently loses precision on values like 0.1 + 0.2,
 * which is unacceptable for money. All comparison/aggregation goes through the
 * BigInt-backed helpers below.
 */
export const DecimalString = z
  .string()
  .regex(/^\d+(\.\d+)?$/, 'must be a non-negative decimal string, e.g. "5.00"');
export type DecimalString = z.infer<typeof DecimalString>;

const DECIMAL_RE = /^\d+(\.\d+)?$/;

export function isValidDecimal(value: string): boolean {
  return DECIMAL_RE.test(value);
}

function assertDecimal(value: string): void {
  if (!isValidDecimal(value)) {
    throw new TypeError(`invalid decimal string: ${JSON.stringify(value)}`);
  }
}

function fractionLength(value: string): number {
  const dot = value.indexOf('.');
  return dot === -1 ? 0 : value.length - dot - 1;
}

/** Scale a decimal string into an integer BigInt at a fixed number of fraction digits. */
function toScaled(value: string, scale: number): bigint {
  const dot = value.indexOf('.');
  const intPart = dot === -1 ? value : value.slice(0, dot);
  const fracPart = dot === -1 ? '' : value.slice(dot + 1);
  const paddedFrac = (fracPart + '0'.repeat(scale)).slice(0, scale);
  return BigInt(intPart + paddedFrac);
}

/** Render a scaled BigInt back to a normalized decimal string (no trailing zeros). */
function fromScaled(scaled: bigint, scale: number): string {
  if (scale === 0) return scaled.toString();
  const digits = scaled.toString().padStart(scale + 1, '0');
  const intPart = digits.slice(0, digits.length - scale);
  const fracPart = digits.slice(digits.length - scale).replace(/0+$/, '');
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

/** Compare two decimal strings. Returns -1 (a<b), 0 (a==b), or 1 (a>b). */
export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  assertDecimal(a);
  assertDecimal(b);
  const scale = Math.max(fractionLength(a), fractionLength(b));
  const av = toScaled(a, scale);
  const bv = toScaled(b, scale);
  return av < bv ? -1 : av > bv ? 1 : 0;
}

/** Sum a list of decimal strings without floating-point error. */
export function sumDecimal(values: readonly string[]): string {
  if (values.length === 0) return '0';
  let scale = 0;
  for (const v of values) {
    assertDecimal(v);
    scale = Math.max(scale, fractionLength(v));
  }
  let total = 0n;
  for (const v of values) total += toScaled(v, scale);
  return fromScaled(total, scale);
}

/**
 * `a - b` for decimal strings, exact. Requires `a >= b`: the one caller is
 * "how much more settled than was allowed", and a negative money string is a
 * shape nothing else in the system accepts, so asking for one is a bug here
 * rather than a value to hand on.
 */
export function subDecimal(a: string, b: string): string {
  if (compareDecimal(a, b) < 0) {
    throw new RangeError(`subDecimal: ${a} is less than ${b}`);
  }
  const scale = Math.max(fractionLength(a), fractionLength(b));
  return fromScaled(toScaled(a, scale) - toScaled(b, scale), scale);
}

/** Multiply two decimal strings exactly (e.g. median * "3" for price-sanity). */
export function mulDecimal(a: string, b: string): string {
  assertDecimal(a);
  assertDecimal(b);
  const scaleA = fractionLength(a);
  const scaleB = fractionLength(b);
  const product = toScaled(a, scaleA) * toScaled(b, scaleB);
  return fromScaled(product, scaleA + scaleB);
}

/** Convenience: a > b. */
export function gt(a: string, b: string): boolean {
  return compareDecimal(a, b) === 1;
}

/** Convenience: a < b. */
export function lt(a: string, b: string): boolean {
  return compareDecimal(a, b) === -1;
}
