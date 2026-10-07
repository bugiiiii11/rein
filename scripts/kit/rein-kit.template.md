# Rein beta -- test kit for {{NAME}}

This file has two parts:

- **Part A** -- your steps (about 10 minutes, one of them in a browser).
- **Part B** -- instructions for Claude Code. You do not read or edit Part B; Claude Code does all of it.

Everything here uses **practice money only** (Base Sepolia testnet). Nothing can cost you anything.

The file contains a private API key for your test agent. It only works for this one test agent on the
practice network, but please do not post it anywhere public.

---

# Part A -- {{NAME}}'s steps

### 1. Put this file in an empty folder and open Claude Code there

```
mkdir rein-beta
cd rein-beta
claude
```

(Save this file into `rein-beta` first, as `rein-kit.md`.) Claude Code first asks **"Do you trust this
folder?"** -- answer **Yes**.

> **Prečo:** Test potrebuje vlastný prázdny priečinok, aby sa nič nepomiešalo s tvojimi inými
> projektmi. Claude Code v ňom nainštaluje dva malé balíčky a vytvorí niekoľko krátkych skriptov --
> všetko zostane len v tomto priečinku a po teste ho môžeš celý zmazať.

### 2. Switch Claude Code out of auto mode

Press **Shift+Tab** until the status line under the input box says **"manual mode on"**. Claude Code
will keep showing "Tip: switch to auto mode" under its answers -- ignore it, never accept it: the kit
only works outside auto mode.

**When VS Code opens a diff that says "Save file to continue":** Claude Code is asking whether it may
write the file. Do not click in the diff -- answer in the Claude Code terminal and pick **1 (Yes)**,
not 2 ("accept edits", which stops asking for the rest of the session).

> **Prečo:** Novšie verzie Claude Code štartujú v "auto mode". V ňom bezpečnostná kontrola sama
> zablokuje inštaláciu balíčkov a volanie nášho servera -- neopýta sa ťa, len to zastaví. Mimo auto
> mode sa Claude Code pri každom príkaze opýta a ty ho schváliš.

### 3. Tell Claude Code to run the kit

Type this into Claude Code:

```
Read rein-kit.md and carry out Part B, step by step.
```

When it asks for permission to run a command (install, run a script), approve it. Answer in the
terminal -- if you use the VS Code terminal and a file tab opens asking to save, the same question is
waiting in the terminal.

Claude Code may say the file contains a key and instructions for it, and suggest checking where the
file came from. That is a good instinct: this file came directly from the Rein team, so continue.

> **Prečo:** Claude Code najprv skontroluje, či máš všetko potrebné (Node.js 22+, npm, prístup na
> naše servery). Ak niečo chýba, povie ti presne, čo nainštalovať. Potom sám nainštaluje balíčky,
> vytvorí skripty a spustí prvý test. Ty nemusíš nič kopírovať ani upravovať ručne.

### 4. Check the first result

Claude Code runs the first test and should show:

```
test 1: ALLOWED BUT UNPAID (decision dec_...)
```

Nothing to do here -- just continue.

> **Prečo:** Toto je "suchý" test bez peňaženky. Tvoj agent sa pýta Rein-u: "môžem si kúpiť túto
> službu?" Rein odpovie "áno" a rozhodnutie podpíše a uloží -- ale keďže agent zatiaľ nemá peňaženku,
> žiadne peniaze sa nepohnú. Ukazuje to hlavnú myšlienku: povolenie na platbu je oddelené od
> samotných peňazí. Rein rozhoduje, ale nikdy nedrží tvoje prostriedky.

### 5. Fund the practice wallet (the only step you do by hand)

Claude Code creates a throwaway wallet and prints a line like:

```
ADDRESS for the faucet: 0x....
```

Then:

1. Open https://faucet.circle.com
2. Network: **Base Sepolia**. Token: **USDC**.
3. Paste the ADDRESS, solve the captcha, click send.
4. Tell Claude Code: `funded`

> **Prečo:** Aby mohol agent skutočne zaplatiť, potrebuje peňaženku s peniazmi. Circle "faucet"
> rozdáva zadarmo cvičné USDC na testovacej sieti -- nemajú žiadnu hodnotu. ETH na poplatky
> nepotrebuješ, poplatok za transakciu platí sprostredkovateľ (facilitátor). Tento krok nemôže
> urobiť Claude Code za teba, lebo faucet vyžaduje captchu. Peňaženka je jednorazová, nikdy do nej
> nevkladaj nič skutočné.

### 6. Wait for the second test (about 1 minute)

Claude Code checks the money arrived, then runs the paid test. You should see:

```
test 1: PAID AND SETTLED -- YOUR payment of $0.001: https://sepolia.basescan.org/tx/0x...
test 2: REFUSED after 7 paid call(s) -- denied by: hour-budget
```

Open the `basescan.org` link -- that is **your** payment, money leaving your practice wallet (not the
faucet sending you funds). Below the RESULT block the script also prints Rein's own record of the
refusal, read back from Rein's signed decision log.

Prices: the first call (ping) costs **$0.001**, each call in test 2 costs **$0.005**, and your agent's
limit is **$0.04 per hour**: $0.001 + 7 x $0.005 = $0.036 fits, an 8th call would make $0.041, so Rein
refuses it.

Sometimes a call shows `NOT paid -- HTTP 402: settle_failed ...`. That is the public practice network's
payment service being busy -- your wallet is fine and no money moved. Send the output as it is. Such a
call still counts toward the $0.04 limit, on purpose: Rein reserves the amount the moment it says yes,
because at that moment nobody can know yet whether the payment will land -- and letting the agent say
"that one failed, give me my budget back" would let a misbehaving agent raise its own limit.

> **Prečo:** Test 1 je skutočná (cvičná) platba: Rein ju povolil, agent zaplatil a platba je
> verejne zapísaná na blockchaine -- overíš si ju na basescan.org bez toho, aby si musel veriť nám.
> Test 2 je to najdôležitejšie: tvoj agent má limit $0.04 za hodinu. Kupuje službu za $0.005
> dookola, a keď by ďalší nákup limit prekročil (8. volanie), Rein ho ZAMIETNE -- ešte predtým, ako
> sa platba vôbec pripraví. Zamietnutie na blockchaine neuvidíš (nič sa nezaplatilo), preto ti ho
> skript ukáže priamo z Rein-ovho podpísaného záznamu. Presne toto je Rein: program s peňaženkou,
> ktorý nemôže minúť viac, než mu dovolíš.

### 7. Send us the result

Send back:

1. The `=== RESULT ===` block Claude Code shows at the end (it includes the refusal record).
2. A few words on each:
   - Where did you get stuck or have to guess?
   - Did anything take longer than expected?
   - In one sentence: what does Rein do?
   - Did anything feel unclear or untrustworthy?

> **Prečo:** Výsledok nám potvrdí, že povolenie, platba aj zamietnutie prebehli u externého
> testera -- to je presne podmienka, ktorú potrebujeme splniť pred ďalšou fázou. My vidíme tvoje
> rozhodnutia aj na našej strane (sú podpísané a uložené v tvojej organizácii), ale tvoja spätná
> väzba -- kde to bolo mätúce -- je pre nás rovnako cenná ako samotný výsledok.

---

# Part B -- instructions for Claude Code

You are helping a beta tester ({{NAME}}) run a short test of Rein, a spend-control layer for AI agent
payments. {{NAME}} asked you to do this. Work in the current folder. Everything runs on the Base Sepolia
**testnet**; no real money is involved.

Rules:

- The API key below is **intentional**: it is a testnet key scoped to one test agent. It goes into
  `rein-agent.json` (B1) and nowhere else. **Never put the key on a command line** and do not print it
  in chat -- every script reads it from that file.
- **Never print the wallet private key** (it lives only in `wallet.json`).
- Do **not** change the logic of the scripts. If something fails, diagnose the ENVIRONMENT (Node
  version, network, TLS/antivirus, npm registry) -- not the code -- and report the exact error text.
- Test 2 spends against a **$0.04 per hour** limit. Run the paid test **once**. If it must be rerun,
  wait an hour first, or Test 1 will be refused by `hour-budget` (that is correct behaviour, not a bug).
- If a command is refused by an "auto mode" classifier, STOP and tell {{NAME}} to press Shift+Tab until
  the status line says "manual mode on" (Part A, step 2), then retry the same command.
- The first time you create a file, VS Code may open a diff saying "Save file to continue". Tell
  {{NAME}} to answer in the Claude Code terminal with option 1 (Yes).
- Keep your messages to {{NAME}} short. After each step, say done / failed and what comes next.

## B1. Pre-flight checks

First create **`rein-agent.json`** with your file-writing tool (not a shell command), exactly:

```json
{
  "engineUrl": "https://engine.reinconsole.com",
  "agentId": "{{AGENT_ID}}",
  "apiKey": "{{API_KEY}}"
}
```

and **`check-engine.mjs`**:

```js
// Pre-flight: is the engine reachable, and is the key in rein-agent.json valid?
import { readFileSync } from 'node:fs';

const { engineUrl, apiKey } = JSON.parse(readFileSync('rein-agent.json', 'utf8'));
const res = await fetch(`${engineUrl}/v1/reconciliation`, { headers: { authorization: `Bearer ${apiKey}` } });
console.log('engine', res.status);
```

Then run these and report a short checklist (OK / MISSING) to {{NAME}}:

1. `node --version` -- must be **v22 or newer**. If missing or older, STOP and tell {{NAME}} to install
   Node.js LTS, then reopen the terminal and restart Claude Code in this folder:
   - Windows: `winget install OpenJS.NodeJS.LTS`
   - macOS: `brew install node` (or the LTS installer from https://nodejs.org)
   - Linux: the LTS package from https://nodejs.org
2. `npm --version` -- must print a version.
3. `node check-engine.mjs` -- must print `engine 200`.
4. Vendor reachable -- must print `vendor 402` (402 = "payment required", which is correct):
   ```
   node -e "fetch('https://vendor.reinconsole.com/testnet/v1/ping').then(r=>console.log('vendor',r.status))"
   ```

If 3 or 4 fails with a certificate error (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`,
`SELF_SIGNED_CERT_IN_CHAIN`), an antivirus or corporate proxy is intercepting HTTPS (Avast, ESET,
Kaspersky, Zscaler...). Tell {{NAME}} to switch off its "HTTPS scanning" / "web shield" for the test, or
run on another network. A `401` on check 3 means the key was mangled -- compare `rein-agent.json` with
this file.

## B2. Install

```
npm init -y
npm install @reinconsole/sdk@{{VERSION}} @reinconsole/x402-rails@{{VERSION}}
```

Must end without `ERR!`. Pin the exact versions shown -- do not use `latest`.

## B3. Create three more files

Create them exactly as given.

**`rein-test.mjs`**

```js
// Rein beta test. Run:  node rein-test.mjs
// First run (no wallet.json yet): permission only, nothing is paid.
// After make-wallet.mjs + faucet: pays with practice USDC, then walks into the hourly limit.
import { existsSync, readFileSync } from 'node:fs';
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { createX402Payer } from '@reinconsole/x402-rails';

const { engineUrl: ENGINE_URL, agentId: AGENT_ID, apiKey: API_KEY } = JSON.parse(readFileSync('rein-agent.json', 'utf8'));

const PING = 'https://vendor.reinconsole.com/testnet/v1/ping'; // $0.001
const SCORES = 'https://vendor.reinconsole.com/testnet/v1/scores/vendor/api.example.com'; // $0.005

const wallet = existsSync('wallet.json') ? JSON.parse(readFileSync('wallet.json', 'utf8')) : null;
const paid = Boolean(wallet?.privateKey);

// 'base-sepolia' only: this key can never pay on the real-money network.
const base = { engineUrl: ENGINE_URL, agentId: AGENT_ID, apiKey: API_KEY, networks: ['base-sepolia'] };
const guard = createGuard(paid ? { ...base, payer: createX402Payer({ privateKey: wallet.privateKey }) } : base);
const plainFetch = globalThis.fetch;
const fetch = guard.wrap();

async function call(url) {
  try {
    return { res: await fetch(url) };
  } catch (err) {
    if (err instanceof PaymentBlockedError) return { blocked: err.decision };
    throw err;
  }
}

// Why an allowed call was not paid: the HTTP status and the vendor's own words.
// A refused payment comes back as a fresh 402 quote with the reason in `error`
// AFTER the quote, so pick the reason fields out rather than printing the body.
async function whyUnpaid(res) {
  const text = res ? await res.text().catch(() => '') : '';
  let why = text;
  try {
    const j = JSON.parse(text);
    why = [j.code, j.error, j.reason].filter((v) => typeof v === 'string').join(' -- ') || text;
  } catch {}
  why = why.replace(/\s+/g, ' ').slice(0, 300);
  return `HTTP ${res?.status ?? 'none'}${why ? `: ${why}` : ''}`;
}

// Rein's own record of a decision, read back from the engine's signed log.
async function engineRecord(id) {
  const headers = { authorization: `Bearer ${API_KEY}` };
  const head = await plainFetch(`${ENGINE_URL}/v1/decisions?limit=1`, { headers });
  const total = Number(head.headers.get('rein-chain-length') ?? 0);
  const after = total > 20 ? `&after=${total - 21}` : '';
  const page = await (await plainFetch(`${ENGINE_URL}/v1/decisions?limit=20${after}`, { headers })).json();
  return Array.isArray(page) ? page.find((d) => d.id === id) : undefined;
}

console.log(`\nRein beta test -- agent ${AGENT_ID}`);
console.log(paid ? `Wallet ${wallet.address}: payments ON (practice money).\n` : 'No wallet.json: payments OFF (correct for the first run).\n');

console.log('--- Test 1: can the agent buy something? ($0.001) ---');
const one = await call(PING);
const r1 = guard.receipts().at(-1);
let result1;
if (one.blocked) {
  result1 = `REFUSED -- ${one.blocked.reason}`;
} else if (!paid && one.res?.status === 402 && r1?.outcome === 'allow') {
  result1 = `ALLOWED BUT UNPAID (decision ${r1.decisionId ?? 'no id'})`;
} else if (paid && one.res?.status === 200 && r1?.settlement?.txHash) {
  result1 = `PAID AND SETTLED -- YOUR payment of $0.001: https://sepolia.basescan.org/tx/${r1.settlement.txHash}`;
} else if (paid && r1?.outcome === 'allow') {
  result1 = `ALLOWED, BUT NOT PAID -- ${await whyUnpaid(one.res)} (if the wallet may be empty, run check-balance.mjs)`;
} else {
  result1 = `UNEXPECTED -- status ${one.res?.status}, outcome ${r1?.outcome ?? 'none'}`;
}
console.log(`  ${result1}`);

let result2 = 'skipped (no wallet)';
let denied;
if (paid) {
  console.log('\n--- Test 2: does the $0.04/hour limit stop the agent? ($0.005 per call) ---');
  let settled = 0;
  let unpaid = 0;
  for (let i = 1; i <= 12 && !denied; i += 1) {
    const c = await call(SCORES);
    if (c.blocked) {
      console.log(`  call ${i}: REFUSED -- ${c.blocked.reason}`);
      if (c.blocked.outcome === 'deny') denied = c.blocked;
    } else {
      const tx = guard.receipts().at(-1)?.settlement?.txHash;
      if (tx) settled += 1;
      else unpaid += 1;
      console.log(`  call ${i}: allowed, ${tx ? `PAID ${tx}` : `NOT paid -- ${await whyUnpaid(c.res)}`}`);
    }
  }
  result2 = denied
    ? `REFUSED after ${settled} paid call(s) -- ${denied.reason}`
    : 'NOTHING REFUSED in 12 calls -- this is a bug, report it';
  if (unpaid > 0) result2 += ` (${unpaid} allowed call(s) not paid -- see the call lines above)`;
  console.log(`  ${result2}`);
}

console.log('\n=== RESULT (send this block back) ===');
console.log(`agent:  ${AGENT_ID}`);
console.log(`wallet: ${wallet?.address ?? 'none'}`);
console.log(`test 1: ${result1}`);
console.log(`test 2: ${result2}`);
if (denied) {
  const rec = await engineRecord(denied.id).catch(() => undefined);
  console.log(
    rec
      ? `refusal in Rein's log: ${rec.id} ${rec.outcome} "${rec.reason ?? ''}" at ${rec.decidedAt ?? '?'}, signed ${String(rec.signature).slice(0, 16)}...`
      : `refusal in Rein's log: ${denied.id} (could not read it back -- send this line anyway)`,
  );
}
console.log('=====================================\n');
```

**`make-wallet.mjs`**

```js
// Creates a throwaway practice wallet in wallet.json. Refuses to overwrite one.
import { existsSync, writeFileSync } from 'node:fs';
import { generateWallet } from '@reinconsole/x402-rails';

if (existsSync('wallet.json')) {
  console.error('wallet.json already exists -- keeping it. Delete it by hand only if you really want a new one.');
  process.exit(1);
}
const w = generateWallet();
writeFileSync('wallet.json', JSON.stringify({ address: w.address, privateKey: w.privateKey }, null, 2));
console.log(`\nWallet created (wallet.json).\nADDRESS for the faucet: ${w.address}\n`);
```

**`check-balance.mjs`**

```js
// Prints the practice-USDC balance of wallet.json's address on Base Sepolia.
import { readFileSync } from 'node:fs';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e'; // Circle USDC, Base Sepolia
const { address } = JSON.parse(readFileSync('wallet.json', 'utf8'));
const data = '0x70a08231' + address.slice(2).toLowerCase().padStart(64, '0');
const res = await fetch('https://sepolia.base.org', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: USDC, data }, 'latest'] }),
});
const { result, error } = await res.json();
if (error) throw new Error(error.message);
const usdc = Number(BigInt(result)) / 1e6;
console.log(`${address}: ${usdc} USDC on Base Sepolia ${usdc > 0 ? '(FUNDED)' : '(EMPTY)'}`);
```

## B4. Test 1 -- permission without payment

```
node rein-test.mjs
```

Expected: `test 1: ALLOWED BUT UNPAID (decision dec_...)`. Show {{NAME}} the RESULT block.

## B5. Create the practice wallet

```
node make-wallet.mjs
```

Show {{NAME}} **only the ADDRESS line**, then tell them:

> Open https://faucet.circle.com, choose **Base Sepolia** + **USDC**, paste this address, send.
> Then reply `funded`.

Wait for {{NAME}}'s reply.

## B6. Confirm the funds arrived

```
node check-balance.mjs
```

Needs `(FUNDED)`. If `(EMPTY)`, wait 30 seconds and check again, up to 5 times. Still empty: ask
{{NAME}} to confirm they chose **Base Sepolia** (not Ethereum Sepolia) and pasted the exact address.
The faucet does not send ETH and none is needed.

## B7. Test 2 -- paid run and the spending limit

Run **once**:

```
node rein-test.mjs
```

Expected:

```
test 1: PAID AND SETTLED -- YOUR payment of $0.001: https://sepolia.basescan.org/tx/0x...
test 2: REFUSED after 7 paid call(s) -- denied by: hour-budget
refusal in Rein's log: dec_... deny "denied by: hour-budget" ...
```

($0.001 + 7 x $0.005 = $0.036 fits the $0.04 limit; the 8th call is refused. The paid count can be lower
if a call shows `NOT paid -- HTTP 402: settle_failed` -- a busy public testnet facilitator, not the
wallet; an unpaid call still counts toward the limit. What matters is a `hour-budget` refusal on test 2
and at least one PAID call.)

## B8. Hand-off

Show {{NAME}} the full final `=== RESULT ===` block and tell them to send it back together with their
feedback (Part A, step 7). Tell them the basescan link in test 1 is THEIR payment (money leaving their
practice wallet). Then remind them that `wallet.json` is a throwaway practice wallet and the folder can
be deleted after the test.

If any result differs from what is expected above, do not try to fix it -- show {{NAME}} the full
output and tell them to send it as is. An unexpected result is a useful result.
