/**
 * The three Path 0 checks against the LIVE estate: engine.reinconsole.com
 * governs, vendor.reinconsole.com charges, Base Sepolia settles. Written for
 * S71's Sprint 5 exit gate and kept as the nightly instrument for it.
 *
 *   node scripts/pilot-checks.mjs --advisory   # check 1 only -- FREE
 *   node scripts/pilot-checks.mjs --all        # all three  -- SPENDS ~$0.047
 *   node scripts/pilot-checks.mjs 2            # one check by number
 *
 * Config comes from the environment, overlaid by `.env.pilot` at the repo root
 * when it exists -- so a laptop run needs no exported variables and a CI run
 * needs no file. Required: REIN_AGENT_ID, REIN_PILOT_AGENT_KEY. Optional:
 * REIN_ENGINE_URL (defaults to the hosted engine), REIN_PAYER_PRIVATE_KEY
 * (required only by checks 2 and 3 -- its ABSENCE is what advisory mode is).
 *
 * Lives in scripts/ because railway.json's watchPatterns subtract it: an ops
 * script the image never runs must not redeploy production when it is edited.
 * That costs the bare specifiers -- the repo root's node_modules/@reinconsole/
 * holds only core and policy-engine -- so the two packages are reached through
 * their built entry points, which resolve their OWN dependencies from their own
 * node_modules. Requires `pnpm build` to have run.
 */
import { existsSync, readFileSync } from 'node:fs';
import { createGuard, PaymentBlockedError } from '../packages/sdk/dist/index.js';
import { createX402Payer } from '../services/x402-rails/dist/index.js';

const ROOT = new URL('../', import.meta.url);
const dotenv = new URL('.env.pilot', ROOT);
// A real environment variable WINS over the file, so CI is never shadowed by a
// stray checked-out .env.pilot and a laptop override needs no file edit.
const env = { ...readEnvFile(dotenv), ...process.env };

function readEnvFile(url) {
  if (!existsSync(url)) return {};
  return Object.fromEntries(
    readFileSync(url, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !l.trimStart().startsWith('#') && l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

const need = (k) => {
  const v = env[k];
  if (!v) throw new Error(`missing ${k} (set it in the environment or .env.pilot)`);
  return v;
};

const arg = process.argv[2] ?? '--all';
const checks =
  arg === '--advisory' ? [1] : arg === '--all' ? [1, 2, 3] : [Number(arg)].filter((n) => n >= 1 && n <= 3);
if (checks.length === 0) throw new Error(`unrecognised argument: ${arg}`);

const ENGINE = env['REIN_ENGINE_URL'] || 'https://engine.reinconsole.com';
const AGENT = need('REIN_AGENT_ID');
const KEY = need('REIN_PILOT_AGENT_KEY');

// Only the spending checks need a key, and demanding one up front would make
// advisory mode -- the whole point of which is having no payer -- unrunnable
// on a runner that holds no wallet.
const spending = checks.some((n) => n !== 1);
const PK = spending ? need('REIN_PAYER_PRIVATE_KEY') : undefined;
if (PK && !/^0x[0-9a-fA-F]{64}$/.test(PK)) {
  throw new Error('REIN_PAYER_PRIVATE_KEY must be 0x + 64 hex characters');
}

const PING = 'https://vendor.reinconsole.com/testnet/v1/ping';
const SCORES = 'https://vendor.reinconsole.com/testnet/v1/scores/vendor/api.example.com';

// The engine cannot tell Base from Base Sepolia (networkToChain folds them
// into one chain), so this list is the only thing stopping a testnet key from
// paying a mainnet 402.
const base = { engineUrl: ENGINE, agentId: AGENT, apiKey: KEY, networks: ['base-sepolia'] };
const payer = () => createX402Payer({ privateKey: PK });

const results = [];
const record = (n, name, pass, detail) => {
  results.push({ n, name, pass });
  console.log(`\n  ${pass ? 'PASS' : 'FAIL'}  check ${n} -- ${name}`);
  console.log(`        ${detail}`);
};

if (checks.includes(1)) {
  console.log('\n[1] advisory -- policy decides, nothing is paid');
  const guard = createGuard(base); // no payer => advisory mode
  const res = await guard.wrap()(PING);
  const r = guard.receipts().at(-1);
  const ok = res.status === 402 && r?.outcome === 'allow' && !r?.settlement;
  record(
    1,
    'ALLOWED_BUT_UNPAID',
    ok,
    ok
      ? `402 released upward unpaid; decision ${r.decisionId ?? '(no id)'} is on the console`
      : `expected 402 + allow + unsettled, got ${res.status} / ${r?.outcome ?? 'no receipt'} / settled=${Boolean(r?.settlement)}`,
  );
}

if (checks.includes(2)) {
  console.log('\n[2] settled -- the Sprint 5 gate, $0.001 on Base Sepolia');
  const guard = createGuard({ ...base, payer: payer() });
  const res = await guard.wrap()(PING);
  const r = guard.receipts().at(-1);
  const tx = r?.settlement?.txHash;
  const ok = res.status === 200 && /^0x[0-9a-fA-F]{64}$/.test(tx ?? '');
  record(
    2,
    'SETTLED',
    ok,
    ok
      ? `tx ${tx} on ${r.settlement.networkId}\n        https://sepolia.basescan.org/tx/${tx}`
      : `expected 200 + a txHash, got ${res.status} / tx=${tx ?? 'none'} / outcome=${r?.outcome ?? 'no receipt'}`,
  );
}

if (checks.includes(3)) {
  console.log('\n[3] denied -- the $0.04 hourly budget refuses a call');
  const guard = createGuard({ ...base, payer: payer() });
  const fetch = guard.wrap();
  let denied;
  for (let i = 1; i <= 12 && !denied; i += 1) {
    try {
      const res = await fetch(SCORES);
      console.log(`        call ${i}  ALLOW  (${res.status})`);
    } catch (err) {
      // A deny is the SUCCESS condition here; anything else is a real failure.
      if (!(err instanceof PaymentBlockedError)) throw err;
      console.log(`        call ${i}  ${err.decision.outcome.toUpperCase()}  ${err.decision.reason}`);
      if (err.decision.outcome === 'deny') denied = err.decision;
    }
  }
  record(
    3,
    'DENIED by hour-budget',
    Boolean(denied),
    denied
      ? `refused before any payment was constructed: ${denied.reason}`
      : '12 calls and nothing was refused -- check pol_pilot_s71 is the applicable policy',
  );
}

console.log(`\n${'-'.repeat(60)}`);
for (const r of results) console.log(`  check ${r.n}  ${r.pass ? 'PASS' : 'FAIL'}  ${r.name}`);
const failed = results.filter((r) => !r.pass).length;
console.log(`  ${results.length - failed}/${results.length} passed\n`);
process.exit(failed ? 1 : 0);
