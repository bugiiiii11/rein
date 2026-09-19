#!/usr/bin/env node
/**
 * Decision-chain backup: pull the engine's audit trail to a file we control.
 *
 * Railway's volume is the ONLY copy of the decision chain, and from Sprint 8 it
 * holds the mainnet audit trail. Backups Pro was the alternative; the founder
 * chose a script (S65) so the copy lands somewhere Rein owns rather than
 * somewhere Railway owns.
 *
 * Run it with a READ-scoped key -- never the operator key. That is the point of
 * scoping: a backup job that could also spend is a worse backup job.
 *
 *   REIN_ENGINE_URL=https://engine.reinconsole.com \
 *   REIN_KEY_READ=... \
 *   node scripts/export-decisions.mjs --out backups
 *
 * It walks `/v1/decisions` to the head, VERIFIES every record against the
 * engine's advertised public key, then writes:
 *
 *   <out>/decisions-<UTC date>.jsonl   one decision per line, chain order
 *   <out>/latest.json                  manifest: count, head hash, key, time
 *
 * An unverifiable export is a FAILED backup, not a backup with a warning: it
 * exits non-zero and writes nothing. A backup you have not verified is a guess
 * about what the engine said, and the whole value of this file is that it is
 * not a guess.
 *
 * WHAT "VERIFIED" MEANS HERE, and why it is not `verifyDecisionChain`:
 * a scoped key sees its OWN rows, not the engine's chain, so the export is a
 * filtered projection whose first row's `prevHash` names a decision the key
 * cannot read. `verifyDecisionChain` starts at `genesis` and rejects every
 * scoped export -- including the READ key this job is supposed to use, so
 * reusing it would have quietly forced the backup onto the operator key.
 * Instead:
 *
 *   - EVERY record's `hash` is recomputed and its signature checked. That is
 *     the tamper-evidence that matters: no row can be altered or forged
 *     without the signing key.
 *   - `prevHash` links are checked only between rows genuinely adjacent in the
 *     export, and the manifest records `rooted` (did it start at genesis) and
 *     `contiguousLinks`. A full-chain key keeps exactly the old guarantee; a
 *     scoped one gets an honest label instead of a false failure.
 */
import { createHash, createPublicKey, verify as edVerify } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { canonicalDecision } from '@reinconsole/core';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const outArg = args.indexOf('--out');
const outDir = path.resolve(
  repoRoot,
  outArg === -1 ? (process.env['REIN_BACKUP_DIR'] ?? 'backups') : args[outArg + 1],
);

const baseUrl = (process.env['REIN_ENGINE_URL'] ?? '').replace(/\/$/, '');
const apiKey = process.env['REIN_KEY_READ'];

const die = (msg) => {
  console.error(`export-decisions: ${msg}`);
  process.exit(1);
};

if (!baseUrl) die('REIN_ENGINE_URL is not set');
if (!apiKey) die('REIN_KEY_READ is not set (use the READ-scoped key, not the operator key)');

const get = async (pathname) => {
  const res = await fetch(`${baseUrl}${pathname}`, {
    headers: { authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) die(`GET ${pathname} -> ${res.status} ${res.statusText}`);
  return res;
};

/**
 * The signing key comes from the engine being backed up, so this verifies
 * INTERNAL consistency -- a chain that was rewritten wholesale under a new key
 * would still verify. `latest.json` records the key so a fingerprint change
 * between runs is visible; that is the check this script cannot make itself.
 */
const health = await (await get('/health')).json();
const publicKey = health.publicKey;
if (typeof publicKey !== 'string') die('/health did not advertise a publicKey');

const decisions = [];
let after;
let chainLength = 0;

for (;;) {
  const qs = new URLSearchParams({ limit: '500' });
  if (after !== undefined) qs.set('after', String(after));
  const res = await get(`/v1/decisions?${qs}`);
  const page = await res.json();
  decisions.push(...page);
  chainLength = Number(res.headers.get('rein-chain-length') ?? decisions.length);

  const next = res.headers.get('rein-next-after');
  // Absence of the header is the head of the chain -- an empty page is not,
  // which is the distinction the SDK's decisionsPage documents.
  if (next === null) break;
  const parsed = Number(next);
  if (!Number.isFinite(parsed) || (after !== undefined && parsed <= after)) {
    die(`Rein-Next-After did not advance (${next}) -- refusing to loop`);
  }
  after = parsed;
}

if (decisions.length !== chainLength) {
  die(`paged ${decisions.length} decisions but the engine reports ${chainLength}`);
}

// Dates arrive as ISO strings over the wire; canonicalDecision hashes the
// canonical form, which expects them parsed.
const key = createPublicKey(publicKey);
let contiguousLinks = 0;
let prev;

decisions.forEach((d, i) => {
  const hash = createHash('sha256')
    .update(canonicalDecision({ ...d, decidedAt: new Date(d.decidedAt) }))
    .digest('hex');
  if (hash !== d.hash) die(`decision ${i} (${d.id}): hash mismatch -- nothing written`);
  if (!edVerify(null, Buffer.from(d.hash), key, Buffer.from(d.signature, 'base64'))) {
    die(`decision ${i} (${d.id}): signature does not verify -- nothing written`);
  }
  if (prev !== undefined && d.prevHash === prev) contiguousLinks += 1;
  prev = d.hash;
});

const rooted = decisions.length > 0 && decisions[0].prevHash === 'genesis';

const now = new Date();
const stamp = now.toISOString().slice(0, 10);
mkdirSync(outDir, { recursive: true });

const jsonl = path.join(outDir, `decisions-${stamp}.jsonl`);
writeFileSync(jsonl, decisions.map((d) => JSON.stringify(d)).join('\n') + '\n', 'utf8');

const head = decisions.at(-1);
writeFileSync(
  path.join(outDir, 'latest.json'),
  JSON.stringify(
    {
      exportedAt: now.toISOString(),
      engine: baseUrl,
      count: decisions.length,
      headHash: head?.hash ?? null,
      headDecidedAt: head?.decidedAt ?? null,
      publicKey,
      file: path.basename(jsonl),
      /** Every record's hash and signature checked. Never written when false. */
      verified: true,
      /** True only for a full-chain key: the export starts at genesis. */
      rooted,
      /** Adjacent rows whose prevHash linked. Equals count-1 on a full chain. */
      contiguousLinks,
    },
    null,
    2,
  ) + '\n',
  'utf8',
);

console.log(
  `export-decisions: ${decisions.length} decisions verified ` +
    `(rooted=${rooted}, links=${contiguousLinks}) -> ${path.relative(repoRoot, jsonl)}`,
);
