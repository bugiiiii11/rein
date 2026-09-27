#!/usr/bin/env node
/**
 * Render a tester's one-file Claude Code kit from scripts/kit/rein-kit.template.md
 * and the `.env.invitee-<slug>` that `invitee-setup.sh` wrote (S80).
 *
 *   node scripts/render-kit.mjs <slug> <Name> [--version 0.3.0-rc.1] [--out file] [--force]
 *
 * Writes `../rein-kit-<slug>.md`, OUTSIDE the repo: a kit carries the tester's
 * agent key, and the repo is public. Only the AGENT key goes in -- the admin
 * key in the same env file is ours and is never sent. Refuses to overwrite an
 * existing kit without --force, since a sent kit is the tester's record of
 * what they were asked to run. The version defaults to @reinconsole/sdk's.
 */
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
const force = args.includes('--force');
const version = flag('--version') ?? JSON.parse(readFileSync(join(root, 'packages/sdk/package.json'), 'utf8')).version;
const [slug, name] = args.filter((a) => a !== '--force');

if (!slug || !name || !/^[a-z0-9-]+$/.test(slug)) {
  console.error('usage: node scripts/render-kit.mjs <slug> <Name> [--version X] [--force]');
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

const out = outFlag ? resolve(outFlag) : resolve(root, '..', `rein-kit-${slug}.md`);
if (existsSync(out) && !force) {
  console.error(`${out} exists -- pass --force to replace it`);
  process.exit(1);
}

const values = { NAME: name, AGENT_ID: agentId, API_KEY: apiKey, VERSION: version };
const kit = readFileSync(join(root, 'scripts/kit/rein-kit.template.md'), 'utf8').replace(
  /\{\{([A-Z_]+)\}\}/g,
  (_, key) => {
    if (!(key in values)) throw new Error(`template placeholder {{${key}}} has no value`);
    return values[key];
  },
);
writeFileSync(out, kit);
console.log(`wrote ${out} (${name}, ${agentId}, packages ${version})`);
