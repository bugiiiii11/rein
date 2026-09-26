/**
 * Sprint 8: mint the founder's approver -- the key that signs "yes" to a
 * parked escalation. Founder-run, from the repo root:
 *
 *   node scripts/approver-setup.mjs
 *
 * 1. Generates an ed25519 keypair HERE. The private half goes to
 *    ~/.rein/approver.pem (owner-only) and never leaves this machine; the
 *    engine only ever holds the public half (A2: Telegram carries the
 *    challenge, the signature is the authority).
 * 2. Registers the public half in Rein's own org (POST /v1/approvers).
 * 3. Mints an `approve` + `read` key for scripts/approve.mjs.
 * 4. Writes .env.approver (gitignored) with everything approve.mjs needs.
 *
 * Refuses to run twice: a second approver is a second authority over the
 * runner's escalations, and should be a decision, not a re-run. Uses the
 * org-scoped admin key from .env.pilot (the one runner-setup.sh used); a real
 * environment variable wins, which is what lets this be rehearsed locally.
 */
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = new URL('../', import.meta.url);
const die = (msg) => {
  console.error(`approver-setup: ${msg}`);
  process.exit(1);
};

function readEnvFile(name) {
  const url = new URL(name, ROOT);
  if (!existsSync(url)) return {};
  return Object.fromEntries(
    readFileSync(url, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trimStart().startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

const env = { ...readEnvFile('.env.pilot'), ...process.env };
const ENGINE = env.REIN_ENGINE_URL || 'https://engine.reinconsole.com';
const ADMIN = env.REIN_APPROVER_ADMIN_KEY || env.REIN_PILOT_ADMIN_KEY || die('missing REIN_PILOT_ADMIN_KEY (.env.pilot)');
const OUT = path.resolve(fileURLToPath(ROOT), env.REIN_APPROVER_OUT || '.env.approver');
const PEM = env.REIN_APPROVER_PEM || path.join(homedir(), '.rein', 'approver.pem');
const NAME = env.REIN_APPROVER_NAME || 'founder';

if (existsSync(OUT)) die(`${OUT} already exists -- the approver is already set up`);
if (existsSync(PEM)) die(`${PEM} already exists -- refusing to overwrite a private key`);

async function post(p, body) {
  const res = await fetch(`${ENGINE}${p}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) die(`POST ${p} -> ${res.status} ${text.slice(0, 300)}`);
  return JSON.parse(text);
}

// The private key is on disk BEFORE the public half is registered, so a
// failure below can never leave a registered approver nobody can sign for.
console.log('1/3 ed25519 keypair');
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
mkdirSync(path.dirname(PEM), { recursive: true });
writeFileSync(PEM, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
console.log(`    private key -> ${PEM} (back it up; it is the only copy)`);

console.log('2/3 register the public half');
const approver = await post('/v1/approvers', {
  name: NAME,
  publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
});
if (!approver.id) die(`no approver id: ${JSON.stringify(approver).slice(0, 200)}`);

console.log('3/3 approve key');
const key = await post('/v1/keys', { name: `${NAME}-approve`, scopes: ['approve', 'read'] });
if (!key.secret) die('no key secret');

writeFileSync(
  OUT,
  [
    `# Rein approver (Sprint 8). GITIGNORED. Generated ${new Date().toISOString()}.`,
    '# Load with:  set -a; . ./.env.approver; set +a   -- then: pnpm approve <decisionId> approve',
    `REIN_ENGINE_URL=${ENGINE}`,
    `REIN_KEY_APPROVE=${key.secret}`,
    `REIN_APPROVER_KEY_ID=${approver.id}`,
    `REIN_APPROVER_PRIVATE_KEY_FILE=${PEM}`,
    '',
  ].join('\n'),
  { mode: 0o600 },
);
console.log(`\nOK -> ${OUT}\n  approver ${approver.id} (${NAME}, org ${approver.orgId})`);
