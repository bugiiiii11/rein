#!/usr/bin/env node
// The suite's test count, derived rather than remembered.
//
//   pnpm test --force > run.log 2>&1
//   node scripts/test-count.mjs --log run.log            # print
//   node scripts/test-count.mjs --log run.log --write    # rewrite the docs
//   node scripts/test-count.mjs --check                  # docs agree with each other?
//
// Three sessions in a row wrapped with a number the docs did not have, because
// the number lives in six places and was hand-edited into each. It is derived
// here instead. The two traps this refuses to walk into:
//
//   1. A WARM turbo cache replays no `Tests` summary, so the sum silently drops
//      whole packages.
//   2. Piping the run through `tail` discards a package's output ENTIRELY.
//
// Both are caught the same way, and it has to be this way: the denominator is
// read from the workspace, not from the log. "Every task I saw also printed a
// summary" is satisfied vacuously by a truncated log -- truncation removes the
// task lines and the summary together -- so only the workspace can say how many
// packages should have reported.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const val = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1]; };

// Each site is a pattern whose FIRST group is the count. Generic in the digits
// so the next run finds them too; anchored in enough context to be unique.
const SITES = [
  ['README.md', /\*\*([\d,]+) tests passing\*\*/],
  ['README.md', /# ([\d,]+) tests, fully offline/],
  ['apps/landing/get-started.html', /([\d,]+)-test suite/],
  ['apps/landing/get-started.html', /the full ([\d,]+) \(~/],
  ['apps/landing/get-started.html', /([\d,]+) offline tests/],
  ['apps/landing/index.html', /(?<=OFFLINE TEST SUITE<\/span>\s*\n\s*<span class="proof-value">)([\d,]+)(?=<\/span>)/],
];

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

/**
 * The live-network suites, SKIPPED unless RUN_LIVE=1. README quotes this
 * number too, and it was stale for the same reason the passing count was: it
 * lived only in prose.
 */
const LIVE_SITES = [['README.md', /plus ([\d,]+) live network tests/]];

function expectedTestPackages() {
  const globs = (readFileSync('pnpm-workspace.yaml', 'utf8').match(/^\s*-\s*'([^']+)'/gm) ?? [])
    .map((l) => l.match(/'([^']+)'/)[1])
    .filter((g) => g.endsWith('/*'));
  const names = new Set();
  for (const g of globs) {
    const dir = g.slice(0, -2);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const manifest = `${dir}/${entry.name}/package.json`;
      if (!existsSync(manifest)) continue;
      const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
      if (pkg.scripts?.test) names.add(pkg.name);
    }
  }
  return names;
}

function parseLog(path) {
  const text = strip(readFileSync(path, 'utf8'));
  const tasks = new Set();
  const summarised = new Map();
  for (const line of text.split('\n')) {
    const pkg = line.match(/^(\S+):test:/)?.[1];
    if (pkg) tasks.add(pkg);
    const m = line.match(/Tests\s+(\d+) passed(?:\s*\|\s*(\d+) skipped)?/);
    if (!m) continue;
    // A package prints more than one summary only if it was retried; the last
    // is the one turbo reports on.
    summarised.set(pkg ?? '(root)', [Number(m[1]), Number(m[2] ?? 0)]);
  }
  if (/EXIT=/.test(text) && !/EXIT=0\b/.test(text)) {
    console.error('FAIL: that run did not exit 0 -- fix the suite before quoting its count');
    process.exit(2);
  }
  const expected = expectedTestPackages();
  const missing = [...expected].filter((t) => !summarised.has(t)).sort();
  if (missing.length) {
    console.error(`FAIL: ${missing.length} of ${expected.size} package(s) with a test script are absent from that log:`);
    for (const m of missing) console.error(`  ${m}${tasks.has(m) ? '  (ran, but printed no summary -- warm cache)' : '  (no output at all -- truncated log)'}`);
    console.error('\nRe-run as:  pnpm test --force > run.log 2>&1   (--force, and no pipe through tail)');
    process.exit(2);
  }
  let passed = 0;
  let skipped = 0;
  for (const name of expected) { const [p, s] = summarised.get(name); passed += p; skipped += s; }
  // Live-gated tests specifically, not every skip: a POSIX-only case a Windows
  // run skips is not a live network test, and counting it as one is how the
  // README ends up quoting a number nothing produces.
  let live = 0;
  const LIVE_LINE = new RegExp(
    String.raw`↓ \S*live\.test\.ts \((\d+) tests? \| (\d+) skipped\)`,
  );
  for (const line of text.split('\n')) {
    const m = line.match(LIVE_LINE);
    if (m) live += Number(m[2]);
  }
  return { passed, skipped, live, packages: expected.size };
}

function readSites(sites = SITES) {
  return sites.map(([file, re]) => {
    const text = readFileSync(file, 'utf8');
    const m = text.match(re);
    if (!m) { console.error(`FAIL: no match for ${re} in ${file} -- the doc was reworded, update SITES`); process.exit(2); }
    return { file, re, found: Number((m[1] ?? m[0]).replace(/,/g, '')) };
  });
}

const logPath = val('--log');
const sites = readSites();

if (!logPath) {
  if (!flag('--check')) { console.error('usage: node scripts/test-count.mjs [--log <file>] [--write|--check]'); process.exit(2); }
  const nums = [...new Set(sites.map((s) => s.found))];
  for (const s of sites) console.log(`  ${s.found}  ${s.file}`);
  for (const s of readSites(LIVE_SITES)) console.log(`  ${s.found}  ${s.file}  (live-gated)`);
  if (nums.length > 1) { console.error(`\nFAIL: the docs disagree with each other: ${nums.join(', ')}`); process.exit(1); }
  console.log(`\nOK: all ${sites.length} sites say ${nums[0]}. Pass --log to check that against a real run.`);
  process.exit(0);
}

const { passed, skipped, live, packages } = parseLog(logPath);
console.log(`${passed} passed, ${skipped} skipped (${live} live-gated), across ${packages} packages`);

const stale = [
  ...sites.filter((s) => s.found !== passed).map((s) => ({ ...s, want: passed })),
  ...readSites(LIVE_SITES).filter((s) => s.found !== live).map((s) => ({ ...s, want: live })),
];
if (!stale.length) { console.log('Docs are current.'); process.exit(0); }

for (const s of stale) console.log(`  ${s.found} -> ${s.want}  ${s.file}`);
if (!flag('--write')) {
  console.error(`\n${stale.length} site(s) stale. Re-run with --write to fix them.`);
  process.exit(1);
}
for (const s of stale) {
  const text = readFileSync(s.file, 'utf8');
  writeFileSync(s.file, text.replace(s.re, (full, n) => full.replace(n ?? full, String(s.want))));
}
console.log(`\nRewrote ${stale.length} site(s).`);
