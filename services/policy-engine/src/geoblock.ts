import { isIP } from 'node:net';
import { GEO_EDITION, GEO_RANGES } from './geo-data.js';

/**
 * The IP geo-block (S98, a legal decision -- docs/legal/decisions.md
 * 2026-10-05): the hosted engine and console refuse requests from
 * comprehensively sanctioned territories with `451 restricted_territory`.
 *
 * The ranges are bundled (geo-data.ts, cut from DB-IP's free CC BY 4.0
 * databases by `scripts/update-geoblock.mjs`), so a lookup sends nobody's
 * address anywhere, costs a binary search, and cannot fail open because a
 * geolocation API is down. The price is freshness: regenerate monthly.
 *
 * What it cannot do, stated so nobody reads more into it: an IP is where a
 * request came FROM, not who sent it -- a VPN walks straight through, and a
 * misfiled range blocks somebody it should not. It is the territorial half of
 * the sanctions posture; wallet screening (screening.ts) is the other half.
 * Private, loopback and unparseable addresses are never blocked: they are not
 * in any territory, and a platform health check arrives from one.
 */

/**
 * The default refused set: the territories under comprehensive OFAC
 * sanctions as of 2026-10 -- Cuba, Iran, North Korea, and the Crimea,
 * so-called DNR and LNR regions of Ukraine (ISO 3166-2: UA-43 Crimea, UA-40
 * Sevastopol, UA-14 Donetsk, UA-09 Luhansk). Syria's program was revoked in
 * 2025, so SY is generated but not refused by default; `REIN_GEOBLOCK` can
 * add it.
 */
export const DEFAULT_GEOBLOCK_TERRITORIES: readonly string[] = ['CU', 'IR', 'KP', 'UA-43', 'UA-40', 'UA-14', 'UA-09'];

export const GEOBLOCK_STATUS = 451;
export const GEOBLOCK_BODY = {
  error: 'restricted_territory',
  message: 'Rein is not available in your region.',
} as const;

interface Table {
  /** Sorted, non-overlapping starts and their ends, with the territory each belongs to. */
  starts: bigint[];
  ends: bigint[];
  owners: string[];
}

/** An address as a BigInt -- v4 in 32 bits, v6 in 128 -- or undefined. */
export function addressValue(ip: string): { family: 4 | 6; value: bigint } | undefined {
  let addr = ip.trim();
  const zone = addr.indexOf('%');
  if (zone >= 0) addr = addr.slice(0, zone);
  // A v4 client on a dual-stack socket arrives as ::ffff:a.b.c.d.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(addr);
  if (mapped) addr = mapped[1]!;
  const family = isIP(addr);
  if (family === 4) {
    return { family, value: addr.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n) };
  }
  if (family !== 6) return undefined;
  // An embedded v4 tail (::1.2.3.4 forms other than the mapped one) as two groups.
  const v4tail = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(addr);
  if (v4tail) {
    const octets = v4tail[1]!.split('.').map(Number);
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    addr = `${addr.slice(0, -v4tail[1]!.length)}${hi}:${lo}`;
  }
  const [head = '', tail = ''] = addr.split('::');
  const groups = (s: string) => (s ? s.split(':') : []);
  const h = groups(head);
  const t = addr.includes('::') ? groups(tail) : [];
  const all = addr.includes('::') ? [...h, ...Array<string>(8 - h.length - t.length).fill('0'), ...t] : h;
  if (all.length !== 8) return undefined;
  return { family, value: all.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n) };
}

function parseRanges(packed: string, width: number): Array<[bigint, bigint]> {
  const out: Array<[bigint, bigint]> = [];
  for (let i = 0; i + 2 * width <= packed.length; i += 2 * width) {
    out.push([BigInt(`0x${packed.slice(i, i + width)}`), BigInt(`0x${packed.slice(i + width, i + 2 * width)}`)]);
  }
  return out;
}

function build(entries: Array<[bigint, bigint, string]>): Table {
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const table: Table = { starts: [], ends: [], owners: [] };
  for (const [s, e, owner] of entries) {
    // Two territories can overlap (DB-IP files Crimea under both RU and UA
    // country rows, and regions come from a second database). Overlap only
    // matters for WHICH territory is named; the earlier range keeps it.
    const last = table.ends.length - 1;
    if (last >= 0 && s <= table.ends[last]!) {
      if (e > table.ends[last]!) {
        table.starts.push(table.ends[last]! + 1n);
        table.ends.push(e);
        table.owners.push(owner);
      }
      continue;
    }
    table.starts.push(s);
    table.ends.push(e);
    table.owners.push(owner);
  }
  return table;
}

function find(table: Table, value: bigint): string | undefined {
  let lo = 0;
  let hi = table.starts.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (value < table.starts[mid]!) hi = mid - 1;
    else if (value > table.ends[mid]!) lo = mid + 1;
    else return table.owners[mid];
  }
  return undefined;
}

export class GeoBlock {
  readonly territories: readonly string[];
  readonly edition = GEO_EDITION;
  private readonly v4: Table;
  private readonly v6: Table;

  constructor(territories: readonly string[] = DEFAULT_GEOBLOCK_TERRITORIES) {
    const unknown = territories.filter((t) => !(t in GEO_RANGES));
    if (unknown.length > 0) {
      throw new Error(
        `geo-block: no ranges for ${unknown.join(', ')}; known: ${Object.keys(GEO_RANGES).join(', ')} ` +
          '(add a territory in scripts/update-geoblock.mjs and regenerate)',
      );
    }
    this.territories = [...territories];
    const v4: Array<[bigint, bigint, string]> = [];
    const v6: Array<[bigint, bigint, string]> = [];
    for (const t of territories) {
      const r = GEO_RANGES[t]!;
      for (const [s, e] of parseRanges(r.v4, 8)) v4.push([s, e, t]);
      for (const [s, e] of parseRanges(r.v6, 32)) v6.push([s, e, t]);
    }
    this.v4 = build(v4);
    this.v6 = build(v6);
  }

  /** The refused territory an address is in, or undefined. */
  territoryOf(ip: string | undefined): string | undefined {
    if (!ip) return undefined;
    const addr = addressValue(ip);
    if (!addr) return undefined;
    return find(addr.family === 4 ? this.v4 : this.v6, addr.value);
  }
}

/** Loopback, link-local and private ranges -- where a platform's proxy reaches us from. */
export function privateAddress(ip: string): boolean {
  const addr = addressValue(ip);
  if (!addr) return false;
  const v = addr.value;
  if (addr.family === 4) {
    const a = Number(v >> 24n);
    const b = Number((v >> 16n) & 0xffn);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  return v === 1n || v >> 121n === 0x7en /* fc00::/7 */ || v >> 118n === 0x3fan /* fe80::/10 */;
}

/**
 * The client of a request that reached us through a proxy on the internal
 * network: walk `X-Forwarded-For` inward from the socket and stop at the first
 * address that is not private. The engine's `trustProxy` does the same walk
 * (`REIN_TRUST_PROXY=1`); this is it for a plain node `http` server (the
 * console). A client connecting directly is never believed, and an entry a
 * client wrote can only ever sit to the LEFT of the one the proxy appended.
 */
export function clientAddress(socketAddress: string | undefined, forwardedFor: string | string[] | undefined): string | undefined {
  let current = socketAddress;
  const header = Array.isArray(forwardedFor) ? forwardedFor.join(',') : forwardedFor;
  const hops = (header ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  while (current && privateAddress(current) && hops.length > 0) current = hops.pop();
  return current;
}

/**
 * `REIN_GEOBLOCK`: `off`, or a comma-separated list of territory codes (ISO
 * 3166-1 alpha-2, or 3166-2 for a region, e.g. `IR,CU,KP,UA-43`). Unset =
 * `fallback` decides -- the hosted bins pass true where they serve strangers
 * (the engine with the sandbox on, the console with sign-in), so the hosted
 * posture does not depend on remembering a variable.
 */
export function geoBlockFromEnv(env: NodeJS.ProcessEnv, fallback: boolean): GeoBlock | undefined {
  const raw = env['REIN_GEOBLOCK']?.trim();
  if (!raw) return fallback ? new GeoBlock() : undefined;
  const value = raw.toLowerCase();
  if (value === 'off' || value === '0' || value === 'false' || value === 'no') return undefined;
  if (value === 'on' || value === '1' || value === 'default') return new GeoBlock();
  return new GeoBlock(
    raw
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean),
  );
}
