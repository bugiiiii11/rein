#!/usr/bin/env node
/**
 * Regenerate `services/policy-engine/src/geo-data.ts`: the IP ranges of the
 * territories the hosted engine and console refuse (see geoblock.ts and
 * docs/legal/decisions.md).
 *
 *   node scripts/update-geoblock.mjs                  # this month's DB-IP edition
 *   node scripts/update-geoblock.mjs --edition 2026-10
 *   node scripts/update-geoblock.mjs --country <file.csv.gz> --city <file.csv.gz> --edition 2026-10
 *
 * Source: DB-IP "IP to Country Lite" for whole countries and "IP to City Lite"
 * for the regions a country database cannot see (Crimea, Sevastopol, Donetsk,
 * Luhansk). Both are CC BY 4.0, which is why the attribution travels with the
 * generated file and the privacy page. The two downloads are ~4 MB and ~85 MB
 * gzipped; both are streamed and never written to disk, because C: is full.
 *
 * Every candidate territory is generated, not only the default blocked set,
 * so an operator can widen `REIN_GEOBLOCK` (Syria, say) without a rebuild.
 * Run monthly; the engine logs the edition at boot.
 */
import { createReadStream, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { isIP } from 'node:net';

const OUT = new URL('../services/policy-engine/src/geo-data.ts', import.meta.url);

/** Whole countries, ISO 3166-1. */
const COUNTRIES = ['CU', 'IR', 'KP', 'SY'];
/**
 * Regions, ISO 3166-2, by the `stateprov` names DB-IP gives them. DB-IP files
 * Crimea under RU and under UA, so the country is not part of the match.
 */
const REGIONS = {
  'UA-43': ['crimea', 'autonomous republic of crimea', 'respublika krym'],
  'UA-40': ['sevastopol', 'sevastopol city'],
  'UA-14': ['donetsk', 'donetsk oblast', "donets'ka oblast'"],
  'UA-09': ['luhansk', 'luhansk oblast', 'lugansk', "luhans'ka oblast'"],
};
const REGION_COUNTRIES = new Set(['UA', 'RU']);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const edition = arg('edition') ?? new Date().toISOString().slice(0, 7);
if (!/^\d{4}-\d{2}$/.test(edition)) throw new Error(`--edition must be YYYY-MM, got ${edition}`);

async function open(kind, file) {
  if (file) return createReadStream(file).pipe(createGunzip());
  const url = `https://download.db-ip.com/free/dbip-${kind}-lite-${edition}.csv.gz`;
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`${url} answered ${res.status}; try --edition with last month`);
  return Readable.fromWeb(res.body).pipe(createGunzip());
}

/** One CSV line; DB-IP quotes fields that hold commas ("South Brisbane"). */
function fields(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i += 1;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** An address as a BigInt, v4 in 32 bits and v6 in 128. */
function toBig(ip) {
  if (isIP(ip) === 4) return ip.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n);
  const [head, tail = ''] = ip.split('::');
  const groups = (s) => (s ? s.split(':') : []);
  const h = groups(head);
  const t = groups(ip.includes('::') ? tail : '');
  const all = ip.includes('::') ? [...h, ...Array(8 - h.length - t.length).fill('0'), ...t] : h;
  if (all.length !== 8) throw new Error(`cannot parse ${ip}`);
  return all.reduce((n, g) => (n << 16n) | BigInt(parseInt(g, 16)), 0n);
}

/** territory -> { v4: [start, end][], v6: [start, end][] } */
const ranges = new Map();
function add(territory, start, end) {
  const family = isIP(start);
  if (family === 0 || isIP(end) !== family) return;
  if (!ranges.has(territory)) ranges.set(territory, { v4: [], v6: [] });
  ranges.get(territory)[family === 4 ? 'v4' : 'v6'].push([toBig(start), toBig(end)]);
}

async function scan(kind, file, onRow) {
  const lines = createInterface({ input: await open(kind, file), crlfDelay: Infinity });
  let n = 0;
  for await (const line of lines) {
    if (!line) continue;
    onRow(fields(line));
    n += 1;
  }
  return n;
}

const countryRows = await scan('country', arg('country'), ([start, end, country]) => {
  if (COUNTRIES.includes(country)) add(country, start, end);
});
const regionNames = new Map(
  Object.entries(REGIONS).flatMap(([code, names]) => names.map((name) => [name, code])),
);
const cityRows = await scan('city', arg('city'), ([start, end, , country, stateprov]) => {
  if (!REGION_COUNTRIES.has(country)) return;
  const code = regionNames.get((stateprov ?? '').trim().toLowerCase());
  if (code) add(code, start, end);
});

/** Sort and merge touching or overlapping ranges. */
function merge(list) {
  list.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const out = [];
  for (const [s, e] of list) {
    const last = out[out.length - 1];
    if (last && s <= last[1] + 1n) {
      if (e > last[1]) last[1] = e;
    } else out.push([s, e]);
  }
  return out;
}

const hex = (n, width) => n.toString(16).padStart(width, '0');
const territories = [...COUNTRIES, ...Object.keys(REGIONS)];
const body = [];
const counts = [];
for (const territory of territories) {
  const r = ranges.get(territory) ?? { v4: [], v6: [] };
  const v4 = merge(r.v4).map(([s, e]) => `${hex(s, 8)}${hex(e, 8)}`);
  const v6 = merge(r.v6).map(([s, e]) => `${hex(s, 32)}${hex(e, 32)}`);
  counts.push(`${territory} ${v4.length}+${v6.length}`);
  body.push(`  '${territory}': {\n    v4: '${v4.join('')}',\n    v6: '${v6.join('')}',\n  },`);
}

writeFileSync(
  OUT,
  `// Generated by scripts/update-geoblock.mjs -- do not edit by hand.
// IP Geolocation by DB-IP (https://db-ip.com), licensed CC BY 4.0
// (https://creativecommons.org/licenses/by/4.0/). Edition ${edition}.
// Each range is start+end in fixed-width hex: 8+8 chars for IPv4, 32+32 for IPv6.

/** The DB-IP edition these ranges were cut from (YYYY-MM). */
export const GEO_EDITION = '${edition}';

export const GEO_RANGES: Readonly<Record<string, { v4: string; v6: string }>> = {
${body.join('\n')}
};
`,
);
console.log(`geo-data.ts written: edition ${edition}; ${countryRows} country rows, ${cityRows} city rows read`);
console.log(`ranges (v4+v6, merged): ${counts.join(', ')}`);
