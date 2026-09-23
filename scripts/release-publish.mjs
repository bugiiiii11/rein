#!/usr/bin/env node
/**
 * Publish every publishable workspace to npm -- the last step of
 * .github/workflows/release.yml (Sprint 8.1, S76).
 *
 *   node scripts/release-publish.mjs --dry-run            # pack + npm publish --dry-run
 *   node scripts/release-publish.mjs --expect-version 0.3.0-rc.1
 *   node scripts/release-publish.mjs --tag next
 *
 * Why pack with pnpm and publish with npm: pnpm 10 never performs npm's OIDC
 * token exchange, so `pnpm -r publish` under Trusted Publishing fails with
 * ENEEDAUTH however the npm side is configured (pnpm grew it in 11, a
 * from-scratch publish rewrite). npm >= 11.5.1 does the exchange, and `pnpm pack`
 * is still what rewrites `workspace:^` into a real range -- npm would publish
 * the protocol verbatim and every dependent would be uninstallable.
 *
 * Order is topological (dependencies first) because a dependent published
 * before its dependency is briefly uninstallable (S49: store vs signer), and
 * the run STOPS at the first failure rather than publishing dependents of a
 * package that did not land. A version already on the registry is skipped, so
 * a run that died halfway is finished by running it again. Exit codes are read
 * from each command, never from a pipeline (S49: `publish | head` read success).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWindows = process.platform === 'win32';
const pnpmCmd = isWindows ? 'pnpm.cmd' : 'pnpm';
const npmCmd = isWindows ? 'npm.cmd' : 'npm';

// ---------------------------------------------------------------- args

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const flag = (name) => {
  const i = argv.indexOf(name);
  if (i === -1) return undefined;
  const v = argv[i + 1];
  if (v === undefined || v.startsWith('--')) die(`${name} needs a value`);
  return v;
};
const expectVersion = flag('--expect-version');
const tagArg = flag('--tag');

function die(msg) {
  console.error(`\n  FAIL  ${msg}`);
  process.exit(1);
}

/** Same shell-quoting rule as package-smoke.mjs: Windows .cmd shims need a shell. */
function run(cmd, args, cwd, stdio = 'pipe') {
  const shell = isWindows && cmd.endsWith('.cmd');
  const finalArgs = shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  return execFileSync(cmd, finalArgs, {
    cwd,
    shell,
    encoding: 'utf8',
    stdio: stdio === 'inherit' ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

// ------------------------------------------------------------ workspaces

/** Every non-private workspace under packages/ and services/ (as package-smoke.mjs). */
function publishableWorkspaces() {
  const out = [];
  for (const group of ['packages', 'services']) {
    const groupDir = path.join(repoRoot, group);
    if (!existsSync(groupDir)) continue;
    for (const entry of readdirSync(groupDir)) {
      const dir = path.join(groupDir, entry);
      const manifestPath = path.join(dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      if (manifest.private === true) continue;
      out.push({ dir, manifest });
    }
  }
  return out;
}

/** Dependencies first; ties broken by name so every run publishes in the same order. */
function topoSort(workspaces) {
  const byName = new Map(workspaces.map((w) => [w.manifest.name, w]));
  const internal = (m) =>
    Object.keys({ ...m.dependencies, ...m.peerDependencies, ...m.optionalDependencies }).filter(
      (d) => byName.has(d) && d !== m.name,
    );
  const ordered = [];
  const done = new Set();
  while (done.size < workspaces.length) {
    const ready = workspaces
      .filter((w) => !done.has(w.manifest.name))
      .filter((w) => internal(w.manifest).every((d) => done.has(d)))
      .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
    if (ready.length === 0) die('dependency cycle between publishable workspaces');
    for (const w of ready) {
      ordered.push(w);
      done.add(w.manifest.name);
    }
  }
  return ordered;
}

/** True if name@version is on the registry; throws on anything but a clean 404. */
function published(name, version) {
  try {
    const out = run(npmCmd, ['view', `${name}@${version}`, 'version', '--json'], repoRoot).trim();
    // npm prints nothing (exit 0) for a range that matches no version.
    return out !== '' && JSON.parse(out) === version;
  } catch (err) {
    const text = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (/E404|404 Not Found/.test(text)) return false;
    throw new Error(`npm view ${name}@${version} failed:\n${text}`);
  }
}

// ------------------------------------------------------------------ main

const workspaces = topoSort(publishableWorkspaces());
if (workspaces.length === 0) die('no publishable workspaces found -- did the layout change?');

const versions = new Set(workspaces.map((w) => w.manifest.version));
if (expectVersion !== undefined) {
  const off = workspaces.filter((w) => w.manifest.version !== expectVersion);
  if (off.length > 0) {
    die(
      `tag says ${expectVersion} but ${off.map((w) => `${w.manifest.name}@${w.manifest.version}`).join(', ')} ` +
        'disagree -- bump every package before tagging',
    );
  }
}

// A prerelease must never become `latest` by omission: that is the tag a bare
// `npm install` resolves, so an rc would reach every user who did not ask for it.
const prerelease = [...versions].some((v) => v.includes('-'));
const distTag = tagArg ?? (prerelease ? 'next' : 'latest');
if (!/^[a-z][a-z0-9-]*$/.test(distTag)) die(`bad dist-tag "${distTag}"`);
if (prerelease && distTag === 'latest') die('refusing to publish a prerelease under `latest`');

const npmVersion = run(npmCmd, ['--version'], repoRoot).trim();
const [maj, min, pat] = npmVersion.split('.').map(Number);
const oidcCapable = maj > 11 || (maj === 11 && (min > 5 || (min === 5 && pat >= 1)));
if (!dryRun && !oidcCapable) {
  die(`npm ${npmVersion} cannot do the Trusted Publishing OIDC exchange; it needs >= 11.5.1`);
}

console.log(
  `\n  ${dryRun ? 'DRY RUN -- nothing reaches the registry' : 'PUBLISHING'}  ` +
    `dist-tag ${distTag}  npm ${npmVersion}  ${workspaces.length} packages\n`,
);

const packRoot = mkdtempSync(path.join(tmpdir(), 'rein-release-'));
const results = [];
for (const { dir, manifest } of workspaces) {
  const id = `${manifest.name}@${manifest.version}`;
  if (!existsSync(path.join(dir, 'dist'))) die(`${manifest.name}: no dist/ -- run \`pnpm build\` first`);

  // A dry run still packs and dry-publishes a version that is already out --
  // otherwise, between releases, it would exercise nothing at all.
  const already = published(manifest.name, manifest.version);
  if (already && !dryRun) {
    console.log(`  skip     ${id}  (already on the registry)`);
    results.push({ id, manifest, state: 'skipped' });
    continue;
  }
  if (already) console.log(`  (${id} is already on the registry -- a real run skips it)`);

  // One directory per package, so the tarball is the only file in it.
  const out = path.join(packRoot, manifest.name.replace('/', '__'));
  mkdirSync(out);
  run(pnpmCmd, ['pack', '--pack-destination', out], dir);
  const tarballs = readdirSync(out).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length !== 1) die(`${manifest.name}: expected one tarball, got ${tarballs.length}`);

  const args = ['publish', path.join(out, tarballs[0]), '--access', 'public', '--tag', distTag];
  // Trusted Publishing attests provenance on its own; the flag makes a
  // misconfigured run (no id-token permission) fail instead of shipping bare.
  if (dryRun) args.push('--dry-run');
  else args.push('--provenance');
  console.log(`  publish  ${id}`);
  try {
    // cwd = the pack dir: nothing in the repo root's .npmrc or manifest applies.
    run(npmCmd, args, out, 'inherit');
  } catch {
    die(`${id} did not publish -- nothing after it in the order was attempted`);
  }
  results.push({ id, manifest, state: dryRun ? 'dry-run' : 'published' });
}

// The registry is the only honest check (S49). A first publish can 404 on its
// packument for a few minutes, so poll before calling it missing.
if (!dryRun) {
  const pending = results.filter((r) => r.state === 'published');
  for (let attempt = 1; pending.length > 0 && attempt <= 12; attempt++) {
    for (const r of [...pending]) {
      if (published(r.manifest.name, r.manifest.version)) pending.splice(pending.indexOf(r), 1);
    }
    if (pending.length > 0) await new Promise((res) => setTimeout(res, 10_000));
  }
  if (pending.length > 0) die(`not visible on the registry after 2 min: ${pending.map((r) => r.id).join(', ')}`);
}

const count = (s) => results.filter((r) => r.state === s).length;
console.log(
  `\n  OK  published ${count('published')}, dry-run ${count('dry-run')}, skipped ${count('skipped')} ` +
    `(dist-tag ${distTag})\n`,
);
