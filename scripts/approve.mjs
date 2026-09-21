#!/usr/bin/env node
/**
 * Answer a parked escalation: fetch it, show it, sign it, submit it.
 *
 * An approval in Rein is an ed25519 SIGNATURE over `decisionId + intentHash +
 * verdict` by a key the engine has registered as an approver. Telegram carries
 * the challenge to a human; it never carries authority (A2 -- no click-to-
 * approve). This script is where the human's private key does its one job.
 * It runs wherever that key lives -- a laptop, an ops box -- and NEVER inside
 * the engine, which only ever holds the public half.
 *
 *   REIN_ENGINE_URL=https://engine.reinconsole.com \
 *   REIN_KEY_APPROVE=rk_...               # an `approve`-scoped key; the GET needs `read`
 *   REIN_APPROVER_KEY_ID=apk_01J...       # the id the engine gave the approver key
 *   REIN_APPROVER_PRIVATE_KEY_FILE=~/.rein/approver.pem \
 *   node scripts/approve.mjs <decisionId> approve|reject [--yes] [--dry-run]
 *
 * `REIN_APPROVER_PRIVATE_KEY` (PEM, escaped newlines accepted) may replace the
 * file. Without `--yes` the script prints the request and STOPS: what a human
 * signs must be what they read, and the printed amount, vendor and resource
 * are the engine's own record of the payment, not the Telegram message. On a
 * second run with `--yes` it signs and submits; `--dry-run` signs and prints
 * the grant without submitting, so a signature can be checked or carried by
 * hand. Every failure is a non-zero exit with one line of reason.
 *
 * It signs with the SAME function the engine verifies with (`signApproval`
 * from `@reinconsole/policy-engine`) rather than re-implementing the
 * canonical form here: a second copy of the byte layout would be a second
 * place for it to drift, and a drifted signature is indistinguishable from a
 * forged one.
 */
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

import { signApproval } from '@reinconsole/policy-engine';

const die = (msg) => {
  console.error(`approve: ${msg}`);
  process.exit(1);
};

// --- Arguments ---

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith('--')));
const positional = args.filter((a) => !a.startsWith('--'));
const [decisionId, verdict] = positional;
const known = new Set(['--yes', '--dry-run']);
for (const f of flags) if (!known.has(f)) die(`unknown flag ${f}`);

if (!decisionId || !verdict) {
  console.error('usage: node scripts/approve.mjs <decisionId> approve|reject [--yes] [--dry-run]');
  process.exit(2);
}
if (verdict !== 'approve' && verdict !== 'reject') {
  die(`verdict must be "approve" or "reject", got "${verdict}"`);
}
const confirmed = flags.has('--yes');
const dryRun = flags.has('--dry-run');

// --- Environment ---

const baseUrl = (process.env['REIN_ENGINE_URL'] ?? '').replace(/\/$/, '');
if (!baseUrl) die('REIN_ENGINE_URL is not set');
const apiKey = process.env['REIN_KEY_APPROVE'];
const approverKeyId = process.env['REIN_APPROVER_KEY_ID'];
if (!approverKeyId) die('REIN_APPROVER_KEY_ID is not set (the apk_... id the engine returned at registration)');

function loadPrivateKey() {
  const inline = process.env['REIN_APPROVER_PRIVATE_KEY'];
  const file = process.env['REIN_APPROVER_PRIVATE_KEY_FILE'];
  let pem;
  if (inline) {
    // The same convention as REIN_APPROVER_PUBLIC_KEY on the console: a PEM
    // pasted into an env var arrives with literal "\n".
    pem = inline.replace(/\\n/g, '\n');
  } else if (file) {
    const resolved = file.startsWith('~') ? path.join(homedir(), file.slice(1)) : file;
    try {
      pem = readFileSync(resolved, 'utf8');
    } catch (err) {
      die(`cannot read REIN_APPROVER_PRIVATE_KEY_FILE ${resolved}: ${err.message}`);
    }
  } else {
    die('set REIN_APPROVER_PRIVATE_KEY_FILE (path to the approver PEM) or REIN_APPROVER_PRIVATE_KEY');
  }
  let key;
  try {
    key = createPrivateKey(pem);
  } catch (err) {
    die(`approver key is not a readable private key PEM: ${err.message}`);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    die(`approver key must be ed25519, got ${key.asymmetricKeyType}`);
  }
  return key;
}

// --- HTTP ---

async function call(method, route, body) {
  const headers = { accept: 'application/json' };
  if (apiKey) headers['authorization'] = `Bearer ${apiKey}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(`${baseUrl}${route}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    die(`${method} ${route}: ${err.cause?.message ?? err.message}`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    die(`${method} ${route}: ${res.status} with a non-JSON body: ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const reason = json?.error ?? json?.message ?? text.slice(0, 200);
    if (res.status === 401) die(`${route}: 401 -- REIN_KEY_APPROVE is missing or wrong`);
    if (res.status === 403) die(`${route}: 403 ${reason} -- the key lacks the scope this needs`);
    if (res.status === 404) die(`${route}: 404 ${reason} -- no such escalation visible to this key`);
    die(`${method} ${route}: ${res.status} ${reason}`);
  }
  return json;
}

// --- Main ---

const { request, challenges } = await call('GET', `/v1/approvals/${encodeURIComponent(decisionId)}`);

const expiresAt = new Date(request.expiresAt);
const msLeft = expiresAt.getTime() - Date.now();
const left =
  msLeft <= 0 ? 'EXPIRED' : msLeft < 60_000 ? `${Math.round(msLeft / 1000)}s left` : `${Math.round(msLeft / 60_000)}m left`;

console.log(`escalation ${request.decisionId}`);
console.log(`  status:    ${request.status} (${left})`);
console.log(`  agent:     ${request.agentId}${request.orgId ? `  org ${request.orgId}` : ''}`);
console.log(`  payment:   ${request.amount} ${request.asset} on ${request.chain}`);
console.log(`  to:        ${request.vendorHost}${request.resource}`);
console.log(`  reason:    ${request.reason}`);
if (request.breakers?.length) console.log(`  breakers:  ${request.breakers.join(', ')} (an approval resets these)`);
if (request.taskId) console.log(`  task:      ${request.taskId}`);
console.log(`  intent:    ${request.intentHash}`);

if (request.status !== 'pending') {
  die(`already ${request.status}${request.finalDecisionId ? ` (decision ${request.finalDecisionId})` : ''}; nothing to sign`);
}
if (msLeft <= 0) {
  die('the request has expired; the engine will deny it on its next sweep, and a signature now changes nothing');
}

// The challenge the engine derived and the one this script would sign must be
// the same bytes. They come from the same function, but the engine's copy is
// the one that will be verified, so it is the one shown.
const challenge = challenges?.[verdict];
if (typeof challenge !== 'string') die(`the engine returned no "${verdict}" challenge for this request`);

if (!confirmed && !dryRun) {
  console.log(`\nwould sign the "${verdict}" challenge:\n  ${challenge}`);
  console.log(`\nre-run with --yes to sign and submit, or --dry-run to sign without submitting.`);
  process.exit(0);
}

const privateKey = loadPrivateKey();
const signature = signApproval(privateKey, {
  decisionId: request.decisionId,
  intentHash: request.intentHash,
  verdict,
});
const grant = { intentHash: request.intentHash, verdict, approverKeyId, signature };

if (dryRun) {
  console.log(`\nsigned (not submitted). POST /v1/approvals/${request.decisionId}/resolve with:`);
  console.log(JSON.stringify(grant, null, 2));
  process.exit(0);
}

const result = await call('POST', `/v1/approvals/${encodeURIComponent(request.decisionId)}/resolve`, grant);
console.log(`\n${verdict === 'approve' ? 'approved' : 'rejected'}: request is now ${result.request.status}`);
console.log(`  final decision:  ${result.decision.id}  (${result.decision.outcome})`);
if (result.decision.hash) console.log(`  chain hash:      ${result.decision.hash}`);
