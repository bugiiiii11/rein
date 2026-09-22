/**
 * Sprint 5 exit gate (S71) -- the three Path 0 checks against the LIVE estate:
 * engine.reinconsole.com governs, vendor.reinconsole.com charges, Base Sepolia
 * settles. Reads .env.pilot at the repo root (gitignored).
 *
 *   node apps/demo/pilot-checks.mjs          # all three, in order
 *   node apps/demo/pilot-checks.mjs 1        # just the advisory check
 *
 * Check 3 SPENDS testnet USDC: up to 9 calls at $0.005. Check 2 spends $0.001.
 * Lives in apps/demo because that is the one package depending on both the SDK
 * and the real x402 rails; a root-level script cannot resolve either.
 */
import { readFileSync } from 'node:fs';
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { createX402Payer } from '@reinconsole/x402-rails';

const ROOT = new URL('../../', import.meta.url);
const env = Object.fromEntries(
  readFileSync(new URL('.env.pilot', ROOT), 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);

const need = (k) => {
  const v = env[k];
  if (!v) throw new Error(`.env.pilot is missing ${k}`);
  return v;
};

const ENGINE = need('REIN_ENGINE_URL');
const AGENT = need('REIN_AGENT_ID');
const KEY = need('REIN_PILOT_AGENT_KEY');
const PK = need('REIN_PAYER_PRIVATE_KEY');
if (!/^0x[0-9a-fA-F]{64}$/.test(PK)) throw new Error('REIN_PAYER_PRIVATE_KEY must be 0x + 64 hex');

const PING = 'https://vendor.reinconsole.com/testnet/v1/ping';
const SCORES = 'https://vendor.reinconsole.com/testnet/v1/scores/vendor/api.example.com';

// The engine cannot tell Base from Base Sepolia (networkToChain folds them),
// so this list is the only thing stopping a testnet key paying a mainnet 402.
const base = { engineUrl: ENGINE, agentId: AGENT, apiKey: KEY, networks: ['base-sepolia'] };

const only = process.argv[2];
const run = (n) => !only || only === String(n);
const results = [];
const record = (n, name, pass, detail) => {
  results.push({ n, name, pass });
  console.log(`\n  ${pass ? 'PASS' : 'FAIL'}  check ${n} -- ${name}`);
  console.log(`        ${detail}`);
};

if (run(1)) {
  console.log('\n[1/3] advisory -- policy decides, nothing is paid');
  const guard = createGuard(base); // no payer => advisory mode
  const res = await guard.wrap()(PING);
  const r = guard.receipts().at(-1);
  const advisory = res.status === 402 && r?.outcome === 'allow' && !r?.settlement;
  record(
    1,
    'ALLOWED_BUT_UNPAID',
    advisory,
    advisory
      ? `402 released upward unpaid; decision ${r.decisionId ?? '(no id)'} is on the console`
      : `expected 402 + allow + unsettled, got ${res.status} / ${r?.outcome} / settled=${Boolean(r?.settlement)}`,
  );
}

if (run(2)) {
  console.log('\n[2/3] settled -- the Sprint 5 gate, $0.001 on Base Sepolia');
  const guard = createGuard({ ...base, payer: createX402Payer({ privateKey: PK }) });
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
      : `expected 200 + a txHash, got ${res.status} / tx=${tx ?? 'none'} / outcome=${r?.outcome}`,
  );
}

if (run(3)) {
  console.log('\n[3/3] denied -- the $0.04 hourly budget refuses a call');
  const guard = createGuard({ ...base, payer: createX402Payer({ privateKey: PK }) });
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
