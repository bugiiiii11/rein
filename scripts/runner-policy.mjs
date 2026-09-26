/**
 * Sprint 8: replace the runner's INTERIM policy with the pilot one, and put
 * the runner under a 6 h dead-man watch. Founder-run, from the repo root:
 *
 *   node scripts/runner-policy.mjs <third-party-host> --dry-run   # validate + print, send nothing
 *   node scripts/runner-policy.mjs <third-party-host>             # POST the policy, PUT the watch
 *
 * <third-party-host> is the ONE catalog vendor the pilot may pay besides
 * vendor.reinconsole.com. Pick it with an advisory run BEFORE this script (the
 * interim policy is default-allow, so the run shows which host the catalog
 * chooses), then pin the runner to it with REIN_RUNNER_THIRD_PARTY_URL: under
 * this policy every other host is denied by default.
 *
 * Same policyId (`pol_runner`), so it REPLACES the interim one -- policies
 * upsert by id, and a second id would be silently ignored because evaluation
 * takes the FIRST applicable policy (S76).
 *
 * Reads the agent id from .env.runner and the org-scoped admin key from
 * .env.pilot (the key runner-setup.sh used). A real environment variable wins.
 * Requires `pnpm build` (the policy is validated against @reinconsole/core's
 * own schema before anything is sent).
 */
import { existsSync, readFileSync } from 'node:fs';
import { Policy } from '../packages/core/dist/index.js';

const ROOT = new URL('../', import.meta.url);

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

const env = { ...readEnvFile('.env.pilot'), ...readEnvFile('.env.runner'), ...process.env };
const die = (msg) => {
  console.error(`runner-policy: ${msg}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const host = args.find((a) => !a.startsWith('--'));
if (!host) die('usage: node scripts/runner-policy.mjs <third-party-host> [--dry-run]');
// A host, not a URL: vendorHostIn matches the request's hostname exactly.
if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) die(`"${host}" is not a bare hostname (no scheme, no path)`);

const ENGINE = env.REIN_ENGINE_URL || 'https://engine.reinconsole.com';
const AGENT = env.REIN_RUNNER_AGENT_ID || die('missing REIN_RUNNER_AGENT_ID (.env.runner)');
const ADMIN = env.REIN_RUNNER_ADMIN_KEY || env.REIN_PILOT_ADMIN_KEY || die('missing REIN_PILOT_ADMIN_KEY (.env.pilot)');
const OWN_VENDOR = 'vendor.reinconsole.com';

// PLAN-PRODUCTION.md Sprint 8. Precedence is deny > escalate > allow >
// default, so a first-seen vendor escalates even though it is allow-listed,
// and nothing outside the list is ever paid.
const policy = Policy.parse({
  policyId: 'pol_runner',
  appliesTo: { agents: [AGENT] },
  default: 'deny',
  rules: [
    { id: 'allowed-vendors', allow: { vendorHostIn: [OWN_VENDOR, host] } },
    { id: 'tx-cap', deny: { amountGt: '0.05' } },
    { id: 'day-budget', deny: { rollingSum: { window: '24h', gt: '1.00' } } },
    { id: 'no-task', deny: { taskIdMissing: true } },
    { id: 'first-seen', escalate: { vendorFirstSeen: true } },
    { id: 'task-budget', escalate: { taskBudget: { gt: '0.25' } } },
  ],
  breakers: [{ id: 'hourly', window: '1h', txCount: 6, valueCap: '0.20' }],
});
const watch = { interval: '6h', note: 'Sprint 8 mainnet runner -- run by hand, at least every 6 h' };

async function call(method, path, body) {
  const res = await fetch(`${ENGINE}${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) die(`${method} ${path} -> ${res.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : undefined;
}

console.log(`engine ${ENGINE}\nagent  ${AGENT}\nhosts  ${OWN_VENDOR}, ${host}\n`);
console.log(JSON.stringify(policy, null, 2));

// Read-only pre-flight. The escalations below park a payment for a SIGNED
// approval; with no approver in the org every first-seen vendor times out
// into a deny, and the pilot could never pay anyone.
const agents = await call('GET', '/v1/agents');
if (!agents.some((a) => a.id === AGENT)) die(`this admin key cannot see ${AGENT} -- wrong org or wrong key`);
const approvers = (await call('GET', '/v1/approvers')).filter((a) => !a.revokedAt);
if (approvers.length === 0) {
  die('no active approver in this org -- register the Telegram approver key first (POST /v1/approvers)');
}
console.log(`\npre-flight OK: agent visible, ${approvers.length} active approver(s): ${approvers.map((a) => a.name).join(', ')}`);

if (dryRun) {
  console.log('\n--dry-run: nothing sent.');
  process.exit(0);
}

const saved = await call('POST', '/v1/policies', policy);
if (saved?.policyId !== 'pol_runner') die(`unexpected POST answer: ${JSON.stringify(saved).slice(0, 200)}`);
// Read it back: the engine's copy is the one that governs.
const live = (await call('GET', '/v1/policies')).filter((p) => p.policyId === 'pol_runner');
if (live.length !== 1 || live[0].default !== 'deny' || live[0].rules.length !== policy.rules.length) {
  die(`read-back mismatch: ${JSON.stringify(live).slice(0, 300)}`);
}
console.log('\npolicy pol_runner REPLACED (read back: default deny, 6 rules, 1 breaker)');

const expectation = await call('PUT', `/v1/agents/${AGENT}/liveness`, watch);
console.log(`liveness watch ON: every ${expectation.interval} (+${expectation.graceMs} ms grace)`);
console.log(`\nNext: pin the runner to the host --  REIN_RUNNER_THIRD_PARTY_URL=https://${host}/...`);
