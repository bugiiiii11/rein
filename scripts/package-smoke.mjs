#!/usr/bin/env node
/**
 * Package smoke test: pack -> install -> import, the way a real consumer does it.
 *
 * Every other test in this repo runs against workspace source, so a broken
 * `exports` map, a missing `files` entry, or an unbuilt `bin` ships silently --
 * that is exactly how the policy-engine bin bug reached npm. This script is the
 * only check that exercises the published artifact instead of the source tree.
 *
 * Run it after `pnpm build`:   pnpm smoke
 *
 * It packs every publishable workspace, installs the tarballs into a throwaway
 * project OUTSIDE the repo (with npm `overrides` so nothing resolves to the
 * registry copy), then imports each entry point and boots each declared bin.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workRoot = path.join(tmpdir(), 'rein-package-smoke');
const packDir = path.join(workRoot, 'tarballs');
const consumerDir = path.join(workRoot, 'consumer');

const isWindows = process.platform === 'win32';
const pnpmCmd = isWindows ? 'pnpm.cmd' : 'pnpm';

const log = (msg) => console.log(msg);
const fail = (msg) => {
  console.error(`\n  FAIL  ${msg}`);
  process.exitCode = 1;
};

/** Every non-private workspace under packages/ and services/. */
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

/**
 * Node >=20 refuses to execFile a .cmd/.bat shim without a shell, and pnpm/npm
 * on Windows are exactly that -- so shell out there, and quote args for it.
 */
function run(cmd, args, cwd) {
  const shell = isWindows && cmd.endsWith('.cmd');
  const finalArgs = shell ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  return execFileSync(cmd, finalArgs, {
    cwd,
    shell,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

// ---------------------------------------------------------------- pack

const workspaces = publishableWorkspaces();
if (workspaces.length === 0) {
  console.error('No publishable workspaces found -- did the layout change?');
  process.exit(1);
}

log(`Packing ${workspaces.length} publishable packages...`);
rmSync(workRoot, { recursive: true, force: true });
mkdirSync(packDir, { recursive: true });
mkdirSync(consumerDir, { recursive: true });

const packed = [];
for (const { dir, manifest } of workspaces) {
  if (!existsSync(path.join(dir, 'dist'))) {
    console.error(`${manifest.name}: no dist/ -- run \`pnpm build\` before \`pnpm smoke\`.`);
    process.exit(1);
  }
  const before = new Set(readdirSync(packDir));
  run(pnpmCmd, ['pack', '--pack-destination', packDir], dir);
  const created = readdirSync(packDir).filter((f) => !before.has(f));
  if (created.length !== 1) {
    console.error(`${manifest.name}: expected exactly one new tarball, got ${created.length}`);
    process.exit(1);
  }
  packed.push({ name: manifest.name, manifest, tarball: path.join(packDir, created[0]) });
  log(`  packed  ${manifest.name}  ->  ${created[0]}`);
}

// ------------------------------------------------------------- install

// `overrides` (not just `dependencies`) is load-bearing: these packages are
// published, so without it an internal ^0.1.1 range is happily satisfied from
// the registry and we would smoke-test the LAST release instead of this build.
const specs = Object.fromEntries(
  packed.map(({ name, tarball }) => [name, `file:${tarball.split(path.sep).join('/')}`]),
);

writeFileSync(
  path.join(consumerDir, 'package.json'),
  `${JSON.stringify(
    {
      name: 'rein-package-smoke-consumer',
      private: true,
      version: '0.0.0',
      type: 'module',
      dependencies: specs,
      pnpm: { overrides: specs },
    },
    null,
    2,
  )}\n`,
);

// pnpm rather than npm, for three reasons: it is the client this project
// already requires, its strict (non-hoisted) node_modules means a package that
// imports something it forgot to declare FAILS here instead of silently
// borrowing it from a flat tree, and it reuses the local store so repeat runs
// are fast. --ignore-workspace keeps a parent workspace from being adopted.
log('\nInstalling tarballs into a throwaway consumer project...');
try {
  run(pnpmCmd, ['install', '--ignore-workspace', '--prefer-offline'], consumerDir);
} catch (err) {
  const output = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  console.error(output);
  console.error('\nInstall of the packed tarballs failed.');
  // This step is the only one that talks to the registry, so it is the only one
  // a TLS-intercepting antivirus or corporate proxy can break. Say so, rather
  // than leaving a raw certificate error to be diagnosed from scratch.
  if (/UNABLE_TO_VERIFY|SELF_SIGNED|CERT_|certificate/i.test(output)) {
    console.error(
      '\nThat looks like intercepted TLS, not a packaging problem. Point' +
        '\nNODE_EXTRA_CA_CERTS at your local root CA bundle and retry:' +
        '\n  $env:NODE_EXTRA_CA_CERTS = "$HOME\\.rein-dev-ca.pem"; pnpm smoke' +
        '\nNote that a `cafile` entry in ~/.npmrc OVERRIDES that variable --' +
        '\nif one is set, the interception root has to be added to that bundle.',
    );
  }
  process.exit(1);
}

// -------------------------------------------------------------- import

// Runs inside the consumer so resolution goes through the installed packages
// and their real `exports` maps -- not through workspace links.
const checkScript = `
import { createRequire } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const names = ${JSON.stringify(packed.map((p) => p.name))};
let failed = 0;

for (const name of names) {
  // Read the manifest off the install path rather than via require.resolve:
  // a well-built package does NOT expose './package.json' through its exports
  // map, so resolving it would fail for the right reasons and mask real ones.
  const pkgDir = path.join(process.cwd(), 'node_modules', ...name.split('/'));
  const manifest = JSON.parse(readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));

  // ESM entry
  try {
    const mod = await import(name);
    const keys = Object.keys(mod).filter((k) => k !== 'default');
    if (keys.length === 0) throw new Error('module resolved but exported nothing');
    console.log('  esm   ' + name.padEnd(28) + keys.length + ' exports');
  } catch (err) {
    console.error('  FAIL  esm ' + name + ': ' + err.message);
    failed++;
  }

  // CJS entry, only where the package actually advertises one. Note that a
  // \`main\` field is NOT evidence of that: most of these are ESM-only builds
  // whose main points at dist/index.js as a legacy fallback, and an exports
  // map without a require condition makes require() correctly unreachable.
  const hasRequire = manifest.exports
    ? Boolean(manifest.exports['.']?.require)
    : Boolean(manifest.main);
  if (hasRequire) {
    try {
      const mod = require(name);
      const keys = Object.keys(mod);
      if (keys.length === 0) throw new Error('module resolved but exported nothing');
      console.log('  cjs   ' + name.padEnd(28) + keys.length + ' exports');
    } catch (err) {
      console.error('  FAIL  cjs ' + name + ': ' + err.message);
      failed++;
    }
  }

  // Types must actually ship -- \`files\` omissions surface here
  const types = manifest.types ?? manifest.exports?.['.']?.types;
  if (types) {
    const typesPath = path.join(pkgDir, types);
    if (!existsSync(typesPath)) {
      console.error('  FAIL  types ' + name + ': declared ' + types + ' is missing from the tarball');
      failed++;
    }
  }

  // Declared bins must exist in the tarball (the S32 regression class)
  for (const [binName, binPath] of Object.entries(manifest.bin ?? {})) {
    const resolved = path.join(pkgDir, binPath);
    if (!existsSync(resolved)) {
      console.error('  FAIL  bin ' + binName + ': ' + binPath + ' is missing from the tarball');
      failed++;
    } else {
      console.log('  bin   ' + binName.padEnd(28) + binPath);
    }
  }
}

process.exit(failed === 0 ? 0 : 1);
`;

writeFileSync(path.join(consumerDir, 'check.mjs'), checkScript);

log('\nImporting each package as a consumer would...');
try {
  const out = run(process.execPath, ['check.mjs'], consumerDir);
  process.stdout.write(out);
} catch (err) {
  process.stdout.write(err.stdout ?? '');
  process.stderr.write(err.stderr ?? '');
  fail('one or more packages could not be consumed from their tarball');
}

// ----------------------------------------------------------- boot bins

/** Boot a bin and wait for it to say it is listening. Proves the shim resolves dist/. */
function bootBin(binName, binFile, expect) {
  return new Promise((resolve) => {
    // PORT=0 lets the OS pick, so a stray engine on 8787 cannot fail this run.
    // cwd is deliberately NOT the consumer dir: on Windows a live child holding
    // it as its working directory makes the cleanup rmdir fail with EBUSY.
    const child = spawn(process.execPath, [binFile], {
      cwd: tmpdir(),
      env: { ...process.env, PORT: '0' },
    });
    let output = '';
    let settled = false;
    const done = (ok, why) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) {
        fail(`bin ${binName} did not boot: ${why}\n${output.trim()}`);
      } else {
        log(`  boot  ${binName.padEnd(28)} ok`);
      }
      // Wait for the process to actually be gone before returning, so cleanup
      // is not racing a still-open handle.
      if (child.exitCode === null && child.signalCode === null) {
        child.once('close', () => resolve());
        child.kill();
        setTimeout(() => resolve(), 2_000).unref();
      } else {
        resolve();
      }
    };
    const timer = setTimeout(() => done(false, 'timed out after 20s'), 20_000);
    const onData = (buf) => {
      output += buf.toString();
      if (output.includes(expect)) done(true);
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', (err) => done(false, err.message));
    child.on('exit', (code) => {
      if (!output.includes(expect)) done(false, `exited early with code ${code}`);
    });
  });
}

const bins = [];
for (const { name, manifest } of packed) {
  for (const [binName, binPath] of Object.entries(manifest.bin ?? {})) {
    const file = path.join(consumerDir, 'node_modules', name, binPath);
    if (existsSync(file)) bins.push({ binName, file });
  }
}

if (bins.length > 0) {
  log('\nBooting declared bins (PORT=0)...');
  for (const { binName, file } of bins) {
    await bootBin(binName, file, 'listening on');
  }
}

// ---------------------------------------------------------------- done

if (process.exitCode) {
  console.error(`\nPackage smoke FAILED. Consumer project left at: ${consumerDir}`);
} else {
  // Best effort only. Windows can still hold handles on a just-exited child's
  // files, and a temp dir that outlives the run is not a reason to fail a
  // green check -- the next run deletes it up front anyway.
  try {
    rmSync(workRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch (err) {
    log(`\n(could not remove ${workRoot}: ${err.code} -- harmless, it is reused next run)`);
  }
  log(`\nPackage smoke passed: ${packed.length} packages packed, installed, imported.`);
}
