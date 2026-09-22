import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The published test count lives in six places, and three sessions in a row
 * shipped a number the docs did not have. `scripts/test-count.mjs` derives it
 * from a real run and rewrites all six; this asserts the weaker property that
 * survives without a run -- that the six still AGREE.
 *
 * That is exactly the failure mode worth catching. Nobody has ever got the
 * count wrong by inventing a number; it goes wrong by editing two of the six
 * sites by hand and believing the job is done. A disagreement here means the
 * script was not the thing that last touched them:
 *
 *   pnpm test --force > run.log 2>&1
 *   node scripts/test-count.mjs --log run.log --write
 *
 * This test deliberately does NOT assert the number itself. It would have to
 * know its own suite's size to do that, and adding a test would then break it.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string): string => readFileSync(join(repoRoot, name), 'utf8');

/** Kept in step with SITES in scripts/test-count.mjs -- one entry per claim. */
const SITES: Array<[string, RegExp]> = [
  ['README.md', /\*\*([\d,]+) tests passing\*\*/],
  ['README.md', /# ([\d,]+) tests, fully offline/],
  ['apps/landing/get-started.html', /([\d,]+)-test suite/],
  ['apps/landing/get-started.html', /the full ([\d,]+) \(~/],
  ['apps/landing/get-started.html', /([\d,]+) offline tests/],
  [
    'apps/landing/index.html',
    /OFFLINE TEST SUITE<\/span>\s*\n\s*<span class="proof-value">([\d,]+)<\/span>/,
  ],
];

describe('published test counts', () => {
  it('every site still states a count', () => {
    for (const [file, pattern] of SITES) {
      // A reworded doc that no longer matches is not a passing test: the
      // script would stop finding the site and the claim would go stale
      // silently, which is the thing being prevented.
      expect(read(file), `${file} no longer matches ${pattern}`).toMatch(pattern);
    }
  });

  it('all six agree with each other', () => {
    const counts = SITES.map(([file, pattern]) => {
      const found = read(file).match(pattern)?.[1].replace(/,/g, '');
      return { site: `${file} ${pattern.source.slice(0, 24)}`, count: Number(found) };
    });
    const distinct = [...new Set(counts.map((c) => c.count))];
    expect(distinct, `sites disagree: ${JSON.stringify(counts)}`).toHaveLength(1);
  });

  it('the script that maintains them lists the same number of sites', () => {
    // Drift the other way: a site added to the docs and the script but not
    // here would leave this test quietly checking a subset.
    const script = read('scripts/test-count.mjs');
    const block = script.slice(script.indexOf('const SITES = ['), script.indexOf('];', script.indexOf('const SITES = [')));
    expect(block.match(/^\s{2}\['/gm) ?? []).toHaveLength(SITES.length);
  });
});
