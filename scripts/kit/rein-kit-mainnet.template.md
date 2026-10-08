# Rein beta -- mainnet kit for {{NAME}}

This file has two parts:

- **Part A** -- your steps (about 20 minutes: one browser sign-in, one message to us, one small transfer).
- **Part B** -- instructions for Claude Code. You do not read or edit Part B; Claude Code does all of it.

This kit uses **real money**: about **$0.05 of USDC on Base** that you send to a fresh wallet. The test
spends at most **$0.01** of it. The rest stays in a wallet whose key only you hold.

The file contains no keys. Everything secret is created on your machine during the test.

---

# Part A -- {{NAME}}'s steps

### 1. Put this file in an empty folder and open Claude Code there

```
mkdir rein-mainnet
cd rein-mainnet
claude
```

(Save this file into `rein-mainnet` first, as `rein-kit.md`.) Answer **Yes** to "Do you trust this folder?".

### 2. Switch Claude Code out of auto mode

Press **Shift+Tab** until the status line says **"manual mode on"**. Ignore the "switch to auto mode" tip.
When VS Code opens a diff saying "Save file to continue", answer in the Claude Code terminal with
**1 (Yes)**.

### 3. Tell Claude Code to run the kit

```
Read rein-kit.md and carry out Part B, step by step.
```

Approve each command it asks to run. Claude Code first makes a free practice sandbox (Base Sepolia,
about 1-2 minutes) -- the same one anybody gets from `npx @reinconsole/init`.

### 4. Sign in, to keep the sandbox

Claude Code runs `--claim`, which opens **app.reinconsole.com/claim** in your browser (if no browser opens,
it shows you the link). Sign in with **GitHub** or an **Ethereum wallet**. One account can own one org,
so use an account that has not claimed a Rein org before.

Why: only a claimed org can go to mainnet. Claiming ties the org to you instead of to a 7-day key.

### 5. Send us your org id, wait for "enabled"

Claude Code then shows a line with your **org id** (`org_...`). Send it to us. We screen the org and
enable mainnet for it, and tell you **"enabled"** -- usually within the hour. Then tell Claude Code:
`enabled`.

Why: real-money access is opened per org, after a sanctions screen of the wallet that will pay.

### 6. Fund the mainnet wallet with about $0.05 USDC on Base

Claude Code shows:

```
ADDRESS to fund (Base mainnet, USDC): 0x....
```

Send **0.05 USDC** on the **Base** network to that address -- from Coinbase ("Send", network Base),
or from any wallet holding USDC on Base. Do **not** send ETH, and do not use Ethereum mainnet: the
wallet needs no gas, the seller's payment service pays it. Then tell Claude Code: `funded`.

This is a fresh wallet made for this test. Its private key is in `rein-agent.json` in this folder and
nowhere else.

### 7. Watch the two tests

```
test 1: REFUSED -- $0.010 is over your $0.004 per-call limit; no money moved (...)
test 2: PAID $0.010 -- https://basescan.org/tx/0x...
```

Between them, Claude Code raises your own per-call limit from $0.004 to $0.01 (and sets a $0.03 daily
limit) with your **owner key** -- the key `--mainnet` saved in your home folder, `~/.rein/`. It shows you
the old and new rules first.

Why: test 1 shows Rein refusing a real seller before any money moves. Test 2 shows the same call
going through once **you** -- not the agent -- changed the limit. The agent's own key cannot change it.

### 8. Send us the result

Send back the `=== RESULT ===` block and a few words on:

- Where did you get stuck or have to guess?
- Did funding the wallet work the way this file says?
- Did anything feel unclear or untrustworthy?

Afterwards: the leftover USDC is yours. `rein-agent.json` holds the wallet key -- keep the file if you
want to move the rest out, and delete the folder when you are done.

---

# Part B -- instructions for Claude Code

You are helping a beta tester ({{NAME}}) run a short test of Rein, a spend-control layer for AI agent
payments, on **Base mainnet with real USDC**. {{NAME}} asked you to do this. Work in the current folder.

Rules:

- **Never print a private key or an API key**, and never put one on a command line. Every script reads
  keys from `rein-agent.json` or the owner file in `~/.rein/`. Show {{NAME}} addresses, ids and
  results only.
- Do **not** change the logic of the scripts. If something fails, diagnose the ENVIRONMENT (Node
  version, network, TLS/antivirus, npm registry) and report the exact error text.
- Run the paid test (B8) **once**. The daily limit after B7 is $0.03, so a mistake cannot cost more.
- If a command is refused by an "auto mode" classifier, STOP and tell {{NAME}} to press Shift+Tab until
  the status line says "manual mode on", then retry.
- Keep your messages to {{NAME}} short. After each step, say done / failed and what comes next.

## B1. Pre-flight checks

Report a short checklist (OK / MISSING):

1. `node --version` -- must be **v22 or newer**. Otherwise STOP: Windows `winget install OpenJS.NodeJS.LTS`,
   macOS `brew install node`, Linux the LTS from https://nodejs.org -- then restart Claude Code here.
2. `npm --version` -- must print a version.
3. Engine and the seller catalog reachable -- must print `engine 200` and `catalog 200`:
   ```
   node -e "fetch('https://engine.reinconsole.com/health').then(r=>console.log('engine',r.status))"
   node -e "fetch('https://facilitator.payai.network/discovery/resources?limit=1').then(r=>console.log('catalog',r.status))"
   ```

A certificate error (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `SELF_SIGNED_CERT_IN_CHAIN`) means an antivirus
or proxy intercepts HTTPS (Avast, ESET, Kaspersky, Zscaler...): tell {{NAME}} to switch off its "HTTPS
scanning" / "web shield" for the test, or use another network.

## B2. The practice sandbox

```
npx -y @reinconsole/init@{{VERSION}}
```

Use a **5-minute** timeout: it waits for test USDC to land. Expected: one `$0.001` call allowed and
settled, one `$0.005` call refused. If it fails, show the output to {{NAME}} and stop.

## B3. Claim it

Run with a **10-minute** timeout (it waits while {{NAME}} signs in):

```
npx -y @reinconsole/init@{{VERSION}} --claim
```

Tell {{NAME}} right away: "Your browser should open app.reinconsole.com/claim -- sign in with GitHub or
an Ethereum wallet you have not used for a Rein org before." If the output shows a link, show the link.
Expected end: the org is claimed and its keys no longer expire. `identity_has_org` means that account
already owns an org: ask {{NAME}} to sign in with a different one and run `--claim` again.

## B4. Move to mainnet

```
npx -y @reinconsole/init@{{VERSION}} --mainnet
```

- If it ends with `mainnet is not yet enabled for org org_...`: show {{NAME}} **the org id** and say:
  "Send this org id to the Rein team and tell me `enabled` when they confirm." Wait. Then run the
  same command again (it resumes; it does not make a second wallet).
- When it succeeds it prints `rein-agent.json is now on Base mainnet` and the owner file path. It
  also tells {{NAME}} to fund the wallet -- B6 covers that, so ignore the rest of its "next steps".

## B5. Install and create the scripts

```
npm init -y
npm install @reinconsole/sdk@{{VERSION}} @reinconsole/x402-rails@{{VERSION}}
```

Must end without `ERR!`. Then create these three files exactly as given.

**`balance.mjs`**

```js
// The mainnet wallet's address and USDC balance on Base. Prints no key.
import { readFileSync } from 'node:fs';

const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'; // Circle USDC, Base mainnet
const a = JSON.parse(readFileSync('rein-agent.json', 'utf8'));
if (a.network !== 'base') throw new Error('rein-agent.json is not on Base mainnet -- run init --mainnet first');
const address = a.wallet.address;
const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
const res = await fetch('https://mainnet.base.org', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC, data }, 'latest'] }),
});
const { result, error } = await res.json();
if (error) throw new Error(error.message);
const usdc = Number(BigInt(result)) / 1e6;
console.log(`ADDRESS to fund (Base mainnet, USDC): ${address}`);
console.log(`balance: ${usdc} USDC ${usdc >= 0.02 ? '(FUNDED)' : '(NOT ENOUGH -- needs at least 0.02)'}`);
```

**`raise-cap.mjs`**

```js
// The OWNER raises the mainnet agent's per-call limit to $0.01 and sets a $0.03 / 24h limit.
// Uses the org admin key from ~/.rein/owner-<org>.json -- the agent's own key cannot do this.
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const a = JSON.parse(readFileSync('rein-agent.json', 'utf8'));
if (a.network !== 'base') throw new Error('rein-agent.json is not on Base mainnet');
const owner = JSON.parse(readFileSync(join(homedir(), '.rein', `owner-${a.orgId}.json`), 'utf8'));
const headers = { authorization: `Bearer ${owner.adminKey}`, 'content-type': 'application/json' };

const listed = await (await fetch(`${a.engineUrl}/v1/policies`, { headers })).json();
const mine = listed.filter((p) => p.appliesTo?.agents?.includes(a.agentId));
if (mine.length !== 1) throw new Error(`expected one policy for ${a.agentId}, found ${mine.length}`);
const { orgId: _org, ...policy } = mine[0];
const rules = [
  { id: 'per-call-cap', deny: { amountGt: '0.01' } },
  { id: 'daily-budget', deny: { rollingSum: { window: '24h', gt: '0.03' } } },
];
const show = (rs) => rs.map((r) => `${r.id} ${JSON.stringify(r.deny)}`).join('; ');
console.log(`policy ${policy.policyId} (agent ${a.agentId})`);
console.log(`  before: ${show(policy.rules)}`);
const res = await fetch(`${a.engineUrl}/v1/policies`, { method: 'POST', headers, body: JSON.stringify({ ...policy, rules }) });
if (res.status !== 200) throw new Error(`engine refused the policy (HTTP ${res.status}): ${await res.text()}`);
console.log(`  after:  ${show((await res.json()).rules)}`);
```

**`mainnet-test.mjs`**

```js
// Rein mainnet test.
//   node mainnet-test.mjs deny   -- find a $0.005-$0.01 seller; Rein refuses it under the $0.004 limit (no payer: nothing CAN be paid)
//   node mainnet-test.mjs pay    -- after raise-cap.mjs: the same seller, one real payment, then Rein's record read back
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { MAINNET, PAYAI_DISCOVERY_URL, createX402Payer, selectDiscovered } from '@reinconsole/x402-rails';

const mode = process.argv[2];
if (mode !== 'deny' && mode !== 'pay') throw new Error('usage: node mainnet-test.mjs deny|pay');
const a = JSON.parse(readFileSync('rein-agent.json', 'utf8'));
if (a.network !== 'base') throw new Error('rein-agent.json is not on Base mainnet');

const networks = [MAINNET.network, MAINNET.caip2];
const base = { engineUrl: a.engineUrl, agentId: a.agentId, apiKey: a.apiKey, networks };
const guard = createGuard(
  mode === 'pay' ? { ...base, payer: createX402Payer({ privateKey: a.wallet.privateKey, networks, profile: MAINNET }) } : base,
);
const fetch = guard.wrap();
const plain = globalThis.fetch;
const usd = (atomic) => `$${(Number(atomic) / 1e6).toFixed(3)}`;

async function call(url) {
  const before = guard.receipts().length;
  try {
    const res = await fetch(url);
    return { res, receipt: guard.receipts().length > before ? guard.receipts().at(-1) : undefined };
  } catch (err) {
    if (err instanceof PaymentBlockedError) return { blocked: err.decision, receipt: err.receipt };
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

async function whyUnpaid(res) {
  const text = res ? await res.text().catch(() => '') : '';
  return `HTTP ${res?.status ?? 'none'}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
}

const lines = [`agent:  ${a.agentId} (org ${a.orgId})`, `wallet: ${a.wallet.address}`];

if (mode === 'deny') {
  console.log('Looking for Base mainnet sellers priced $0.005-$0.01 in the PayAI catalog...');
  const items = [];
  for (let page = 0; page < 60; page += 1) {
    const res = await plain(`${PAYAI_DISCOVERY_URL}?limit=100&offset=${page * 100}`);
    if (!res.ok) throw new Error(`catalog HTTP ${res.status}`);
    const body = await res.json();
    items.push(...body.items);
    if (body.items.length < 100) break;
  }
  // What a seller says it needs. A seller answers a bare GET with its 402 and checks its
  // input only AFTER the payment arrives, so a missing parameter fails the PAID call.
  const inputOf = new Map(items.map((e) => [e?.resource, e?.extensions?.bazaar?.info?.input ?? e?.accepts?.[0]?.outputSchema?.input]));
  const withInput = (c) => {
    const input = inputOf.get(c.resource) ?? {};
    const query = input.queryParams ?? {};
    if (input.bodyFields || input.body) return undefined;
    if (!Object.values(query).every((v) => typeof v === 'string' || typeof v === 'number')) return undefined;
    const url = new URL(c.resource);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    return { ...c, url: url.href, params: Object.keys(query).length };
  };
  const found = selectDiscovered(items, { profile: MAINNET, maxAtomic: 10_000n, excludeHosts: ['vendor.reinconsole.com'] })
    .filter((c) => c.amount > 4_000n)
    .map(withInput)
    .filter(Boolean);
  // Sellers needing no input first, then the dearest: test 2 pays at most what the raised limit allows.
  found.sort((x, y) => x.params - y.params || Number(y.amount - x.amount));
  // One seller per operator: the catalog lists dozens of endpoints of a single host, and one host down must not end the test.
  const operators = new Set();
  const picks = found.filter((c) => {
    const op = new URL(c.url).hostname.split('.').slice(-2).join('.');
    return operators.has(op) ? false : operators.add(op);
  });
  let result = `NO SELLER -- ${found.length} catalog match(es), none answered with a payable 402`;
  for (const c of picks.slice(0, 8)) {
    const r = await call(c.url);
    if (r.blocked?.outcome === 'deny') {
      writeFileSync('seller.json', JSON.stringify({ url: c.url, amount: String(c.amount) }, null, 2));
      result = `REFUSED -- ${usd(c.amount)} is over your $0.004 per-call limit; no money moved (${r.blocked.reason}, decision ${r.blocked.id})`;
      lines.push(`seller: ${c.url}`);
      break;
    }
    if (r.receipt) {
      result = `UNEXPECTED -- ${c.url} was ${r.receipt.outcome} at ${usd(c.amount)}, not refused`;
      break;
    }
    console.log(`  skip ${c.url} (${r.error ?? `HTTP ${r.res?.status}, no paywall`})`);
  }
  lines.push(`test 1: ${result}`);
} else {
  if (!existsSync('seller.json')) throw new Error('no seller.json -- run `node mainnet-test.mjs deny` first');
  const seller = JSON.parse(readFileSync('seller.json', 'utf8'));
  lines.push(`seller: ${seller.url}`);
  const r = await call(seller.url);
  let result;
  if (r.blocked) result = `REFUSED -- ${r.blocked.reason} (did raise-cap.mjs run?)`;
  else if (r.error) result = `ERROR -- ${r.error}`;
  else if (r.res.status < 400 && r.receipt?.settlement?.txHash)
    result = `PAID ${usd(seller.amount)} -- https://basescan.org/tx/${r.receipt.settlement.txHash}`;
  else if (r.receipt?.outcome === 'allow')
    result = `ALLOWED, NOT CONFIRMED PAID -- ${await whyUnpaid(r.res)} (check the wallet balance before retrying anything)`;
  else result = `UNEXPECTED -- HTTP ${r.res?.status}, outcome ${r.receipt?.outcome ?? 'none'}`;
  lines.push(`test 2: ${result}`);

  // Rein's own account, read with the OWNER key: allowed vs settled vs overspent for this agent.
  const owner = JSON.parse(readFileSync(join(homedir(), '.rein', `owner-${a.orgId}.json`), 'utf8'));
  const headers = { authorization: `Bearer ${owner.adminKey}` };
  await new Promise((done) => setTimeout(done, 3_000));
  const rec = await (await plain(`${a.engineUrl}/v1/reconciliation?agentId=${a.agentId}&graceMs=0`, { headers })).json();
  lines.push(
    `Rein's record (24h): allowed ${rec.allowed} ($${rec.allowedValue}), settled ${rec.settled} ($${rec.settledValue}), ` +
      `overspent ${rec.overspent}`,
  );
}

console.log('\n=== RESULT (send this block back) ===');
for (const l of lines) console.log(l);
console.log('=====================================\n');
```

## B6. Fund the wallet

```
node balance.mjs
```

Show {{NAME}} the **ADDRESS line only** and say:

> Send **0.05 USDC on the Base network** to this address (Coinbase: Send -> USDC -> network **Base**).
> No ETH is needed. Tell me `funded` when it is sent.

After `funded`, run `node balance.mjs` until it says `(FUNDED)` -- every 30 seconds, up to 10 times. Still
not funded: ask {{NAME}} to check that the network was **Base** (not Ethereum) and the address was exact.

## B7. Test 1 -- refused, then the owner raises the limit

```
node mainnet-test.mjs deny
```

Expected: `test 1: REFUSED -- $0.010 is over your $0.004 per-call limit; no money moved (...)`. If it
says `NO SELLER` or `UNEXPECTED`, show {{NAME}} the full output and stop -- do NOT continue to B8.

Then tell {{NAME}} "Now your owner key raises the limit to $0.01 per call, $0.03 per day", and run:

```
node raise-cap.mjs
```

Show {{NAME}} the before / after lines.

## B8. Test 2 -- one real payment

Run **once**:

```
node mainnet-test.mjs pay
node balance.mjs
```

Expected: `test 2: PAID $0.010 -- https://basescan.org/tx/0x...`, Rein's record showing `settled 1` and
`overspent 0`, and the balance about $0.01 lower. Tell {{NAME}} the basescan link is THEIR payment, on
the public chain. Do not rerun on any other result -- show the output as it is.

## B9. Hand-off

Show {{NAME}} both `=== RESULT ===` blocks (test 1 and test 2) and tell them to send both back with
their feedback (Part A, step 8). Remind them the leftover USDC is theirs, its key is in `rein-agent.json`,
and the owner file in `~/.rein/` is the only copy of their org admin key.

If any result differs from what is expected, do not try to fix it -- show the full output. An
unexpected result is a useful result.
