/**
 * Minimal ULID generation, dependency-free. ULIDs are lexicographically
 * sortable (time-prefixed) and url-safe, which is why Rein uses them for all
 * primary keys instead of UUIDs. Works in Node 22 and modern browsers/edge via
 * the WebCrypto `globalThis.crypto`.
 */

// Crockford's base32 alphabet (excludes I, L, O, U to avoid ambiguity).
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RANDOM_LEN = 16;

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

function encodeTime(now: number): string {
  let time = now;
  let out = '';
  for (let i = TIME_LEN - 1; i >= 0; i--) {
    out = ENCODING.charAt(time % 32) + out;
    time = Math.floor(time / 32);
  }
  return out;
}

function encodeRandom(): string {
  let out = '';
  for (const byte of randomBytes(RANDOM_LEN)) {
    out += ENCODING.charAt(byte % 32);
  }
  return out;
}

/** Generate a 26-character ULID. */
export function ulid(seedTime: number = Date.now()): string {
  return encodeTime(seedTime) + encodeRandom();
}

/** Generate a Stripe-style prefixed id, e.g. `newId('agt')` -> `agt_01J...`. */
export function newId<P extends string>(prefix: P): `${P}_${string}` {
  return `${prefix}_${ulid()}`;
}
