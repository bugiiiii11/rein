/**
 * Sprint 8: rehearse the kill switch on TESTNET before the runner touches
 * mainnet. Founder-run, from the repo root (needs `pnpm build`):
 *
 *   node scripts/killswitch-rehearsal.mjs
 *
 * Drives the pilot agent (.env.pilot, Rein's own org) through the two
 * emergency brakes, checking each from the agent's side -- a real SDK guard
 * asking to pay the testnet ping, advisory only, so nothing is ever paid:
 *
 *   1. baseline             -> allowed
 *   2. freeze the agent     -> every evaluate DENIED (`agent-frozen`)
 *   3. unfreeze             -> allowed again
 *   4. revoke the agent key -> the engine refuses the key itself (401)
 *
 * Step 4 revokes a THROWAWAY key minted for this run, never the pilot's own:
 * that one drives the nightly live.yml checks. The agent is unfrozen in a
 * `finally`, because a pilot agent left frozen silently fails every nightly
 * check. On mainnet the same two calls are the runbook -- freeze first (instant,
 * reversible, keeps the audit trail), revoke the runner key second.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createGuard, PaymentBlockedError } from '../packages/sdk/dist/index.js';

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

const env = { ...readEnvFile('.env.pilot'), ...process.env };
const need = (k) => env[k] || (console.error(`missing ${k} (.env.pilot)`), process.exit(1));
const ENGINE = env.REIN_ENGINE_URL || 'https://engine.reinconsole.com';
const AGENT = need('REIN_AGENT_ID');
const ADMIN = need('REIN_PILOT_ADMIN_KEY');
const PING = env.REIN_REHEARSAL_URL || 'https://vendor.reinconsole.com/testnet/v1/ping';

async function admin(method, p, body) {
  const res = await fetch(`${ENGINE}${p}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : undefined;
}

/** One advisory purchase attempt, as the agent sees it. */
async function attempt(apiKey) {
  const guard = createGuard({ engineUrl: ENGINE, agentId: AGENT, apiKey, networks: ['base-sepolia'] });
  try {
    const res = await guard.wrap()(PING);
    const r = guard.receipts().at(-1);
    return r?.outcome === 'allow' && res.status === 402 ? 'allow' : `unexpected (${res.status}, ${r?.outcome})`;
  } catch (err) {
    if (err instanceof PaymentBlockedError) return `deny: ${err.decision.reason}`;
    const status = err?.status ?? err?.cause?.status;
    return status ? `engine-refused ${status}` : `error: ${err instanceof Error ? err.message : err}`;
  }
}

const results = [];
function check(step, got, pass) {
  results.push(pass);
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${step}\n        ${got}`);
}

console.log(`\nKill-switch rehearsal -- agent ${AGENT} on ${ENGINE}\n`);
const temp = await admin('POST', '/v1/keys', {
  name: `killswitch-rehearsal-${Date.now()}`,
  scopes: ['evaluate', 'read'],
  agentIds: [AGENT],
});
let frozen = false;
try {
  let got = await attempt(temp.secret);
  check('1 baseline: allowed', got, got === 'allow');

  await admin('POST', `/v1/agents/${AGENT}/freeze`);
  frozen = true;
  got = await attempt(temp.secret);
  check('2 frozen: denied by the kill switch', got, got.startsWith('deny') && got.includes('frozen'));

  await admin('POST', `/v1/agents/${AGENT}/unfreeze`);
  frozen = false;
  got = await attempt(temp.secret);
  check('3 unfrozen: allowed again', got, got === 'allow');

  await admin('POST', `/v1/keys/${temp.key.id}/revoke`);
  got = await attempt(temp.secret);
  check('4 key revoked: the engine refuses the key', got, got === 'engine-refused 401');
} finally {
  if (frozen) {
    await admin('POST', `/v1/agents/${AGENT}/unfreeze`);
    console.log('  (agent unfrozen after a failure -- the pilot must not stay frozen)');
  }
}

const ok = results.length === 4 && results.every(Boolean);
console.log(`\n${ok ? 'REHEARSAL PASSED' : 'REHEARSAL FAILED'} (${results.filter(Boolean).length}/4)\n`);
process.exit(ok ? 0 : 1);
