#!/usr/bin/env node
/**
 * Render a tester's one-file Claude Code kit from scripts/kit/rein-kit.template.md
 * (or, with `--kit signer`, rein-kit-signer.template.md -- the custody tier, S102)
 * and the `.env.invitee-<slug>` that `invitee-setup.sh` wrote (S80).
 *
 *   node scripts/render-kit.mjs <slug> <Name> [--kit signer] [--version 0.3.0-rc.1] [--out file] [--force]
 *
 * Writes `../rein-kit-<slug>.md`, OUTSIDE the repo: a kit carries the tester's
 * agent key, and the repo is public. Only the AGENT key goes in -- the admin
 * key in the same env file is ours and is never sent. Refuses to overwrite an
 * existing kit without --force, since a sent kit is the tester's record of
 * what they were asked to run. The version defaults to @reinconsole/sdk's.
 */
import { createPublicKey } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args.splice(i, 2)[1];
};
const outFlag = flag('--out');
const kitKind = flag('--kit') ?? 'guard';
const force = args.includes('--force');
const version = flag('--version') ?? JSON.parse(readFileSync(join(root, 'packages/sdk/package.json'), 'utf8')).version;
const [slug, name] = args.filter((a) => a !== '--force');

if (!slug || !name || !/^[a-z0-9-]+$/.test(slug) || !['guard', 'signer'].includes(kitKind)) {
  console.error('usage: node scripts/render-kit.mjs <slug> <Name> [--kit guard|signer] [--version X] [--force]');
  process.exit(1);
}

// The signer kit's replay test re-issues a spent voucher under a fresh id, which
// only a signer that burns by decision HASH refuses (CHANGELOG: Unreleased at
// S102). Rendering it against an older release would hand a tester a kit whose
// headline test fails on purpose.
const MIN_SIGNER_KIT_VERSION = '0.5.2';
const numeric = (v) => v.split('-')[0].split('.').map(Number);
const older = (a, b) => {
  const [x, y] = [numeric(a), numeric(b)];
  for (let i = 0; i < 3; i += 1) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0);
  return false;
};
if (kitKind === 'signer' && older(version, MIN_SIGNER_KIT_VERSION)) {
  console.error(
    `the signer kit needs @reinconsole/signer >= ${MIN_SIGNER_KIT_VERSION} on npm (the hash-keyed replay burn); ` +
      `${version} would sign the re-id'd voucher in test 2. Release first, then pass --version.`,
  );
  process.exit(1);
}

const envPath = join(root, `.env.invitee-${slug}`);
if (!existsSync(envPath)) {
  console.error(`no ${envPath} -- run: bash scripts/invitee-setup.sh ${slug}`);
  process.exit(1);
}
const env = Object.fromEntries(
  readFileSync(envPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()]),
);
const agentId = env.REIN_INVITEE_AGENT_ID;
const apiKey = env.REIN_INVITEE_AGENT_KEY;
if (!agentId?.startsWith('agt_') || !apiKey?.startsWith('rk_')) {
  console.error(`${envPath} lacks REIN_INVITEE_AGENT_ID / REIN_INVITEE_AGENT_KEY`);
  process.exit(1);
}

const outName = kitKind === 'signer' ? `rein-kit-signer-${slug}.md` : `rein-kit-${slug}.md`;
const out = outFlag ? resolve(outFlag) : resolve(root, '..', outName);
if (existsSync(out) && !force) {
  console.error(`${out} exists -- pass --force to replace it`);
  process.exit(1);
}

const values = { NAME: name, AGENT_ID: agentId, API_KEY: apiKey, VERSION: version };
if (kitKind === 'signer') {
  // The signer pins the engine key the KIT carries (Matt, S103: reading it from
  // /health at the tester's boot is trust-on-first-use, not a pin). Read here,
  // on the operator's machine, and delivered with the kit -- a channel the
  // engine's network path does not control.
  const engineUrl = env.REIN_ENGINE_URL || 'https://engine.reinconsole.com';
  const health = await (await fetch(`${engineUrl}/health`)).json();
  if (typeof health.publicKey !== 'string' || !health.publicKey.includes('BEGIN PUBLIC KEY')) {
    console.error(`${engineUrl}/health returned no public key`);
    process.exit(1);
  }
  // The operator's own copy of the signing key, when present (gitignored, repo
  // root), is the real anchor: the live engine must present ITS public half.
  const keyFile = join(root, 'engine-signing-key.pem');
  if (existsSync(keyFile)) {
    const own = createPublicKey(readFileSync(keyFile)).export({ type: 'spki', format: 'pem' }).toString().trim();
    if (own !== health.publicKey.trim()) {
      console.error(`${engineUrl}/health presents a key that is NOT engine-signing-key.pem's -- not rendering`);
      process.exit(1);
    }
  } else {
    console.warn(`no engine-signing-key.pem here: pinning the key ${engineUrl}/health presents now, unchecked`);
  }
  values.ENGINE_PUBLIC_KEY = health.publicKey.trim();
}
const templateName = kitKind === 'signer' ? 'rein-kit-signer.template.md' : 'rein-kit.template.md';
const kit = readFileSync(join(root, 'scripts/kit', templateName), 'utf8').replace(
  /\{\{([A-Z_]+)\}\}/g,
  (_, key) => {
    if (!(key in values)) throw new Error(`template placeholder {{${key}}} has no value`);
    return values[key];
  },
);
writeFileSync(out, kit);
console.log(`wrote ${out} (${kitKind} kit, ${name}, ${agentId}, packages ${version})`);
