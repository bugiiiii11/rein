# Rein beta -- signer test kit for {{NAME}}

This file has two parts:

- **Part A** -- your steps (about 10 minutes; one browser step only if you have no practice wallet yet).
- **Part B** -- instructions for Claude Code. You do not read or edit Part B; Claude Code does all of it.

Everything here uses **practice money only** (Base Sepolia testnet). Nothing can cost you anything.

The file contains a private API key for your test agent. It only works for this one test agent on the
practice network, but please do not post it anywhere public.

---

# Part A -- {{NAME}}'s steps

### 1. Put this file in an empty folder and open Claude Code there

```
mkdir rein-signer
cd rein-signer
claude
```

(Save this file into `rein-signer` first, as `rein-kit-signer.md`.) If you still have the `rein-beta`
folder from the earlier kit, copy its `wallet.json` into `rein-signer` -- that wallet is already funded
and you skip step 4. Claude Code first asks **"Do you trust this folder?"** -- answer **Yes**.

> **Prečo:** V prvom kite mal tvoj agent kľúč od peňaženky priamo u seba a Rein mu len radil. Tento
> kit ukazuje vyšší stupeň: kľúč od peňaženky drží samostatný proces ("signer") a agent dostane len
> časovo obmedzený, limitovaný lístok. Bez podpísaného "áno" od Rein-u signer nikdy nepodpíše platbu.

### 2. Switch Claude Code out of auto mode

Press **Shift+Tab** until the status line under the input box says **"manual mode on"**. Claude Code
will keep showing "Tip: switch to auto mode" under its answers -- ignore it, never accept it: the kit
only works outside auto mode.

**When VS Code opens a diff that says "Save file to continue":** Claude Code is asking whether it may
write the file. Do not click in the diff -- answer in the Claude Code terminal and pick **1 (Yes)**,
not 2 ("accept edits", which stops asking for the rest of the session).

> **Prečo:** V "auto mode" bezpečnostná kontrola sama zablokuje inštaláciu balíčkov a volanie nášho
> servera. Mimo auto mode sa Claude Code pri každom príkaze opýta a ty ho schváliš.

### 3. Tell Claude Code to run the kit

Type this into Claude Code:

```
Read rein-kit-signer.md and carry out Part B, step by step.
```

Approve the commands it asks about (install, run a script, run the signer in the background). Claude
Code may say the file contains a key and instructions for it, and suggest checking where the file came
from. That is a good instinct: this file came directly from the Rein team, so continue.

### 4. Fund the practice wallet (only if you have no `wallet.json` from the earlier kit)

Claude Code creates a throwaway wallet and prints `ADDRESS for the faucet: 0x...`. Open
https://faucet.circle.com, choose **Base Sepolia** + **USDC**, paste the address, send, then tell Claude
Code: `funded`.

> **Prečo:** Faucet vyžaduje captchu, preto to Claude Code nemôže urobiť za teba. Peňaženka je
> jednorazová, nikdy do nej nevkladaj nič skutočné.

### 5. Watch the three tests

Claude Code starts the signer (it keeps running in the background), then runs the agent. You should see:

```
test1: PAID AND SETTLED -- signed by the signer, YOUR payment of $0.001: https://sepolia.basescan.org/tx/0x...
test2: REFUSED [decision_replayed] ... / re-id'd copy: REFUSED [decision_replayed] ...
```

then, after Claude Code revokes the session:

```
test3: REFUSED by the signer [session_revoked] after Rein ALLOWED (decision dec_...)
```

> **Prečo:** Test 1: agent zaplatil, ale kľúč od peňaženky nikdy nemal -- platbu podpísal signer, a
> len preto, že k nej mal podpísané povolenie od Rein-u (tzv. voucher). Test 2: agent skúsi ten istý
> voucher použiť druhýkrát, raz presne a raz s novým identifikátorom; signer oboje odmietne, lebo
> voucher sa dá minúť iba raz. Test 3: operátor stlačí "kill switch" -- zruší agentovi lístok. Rein by
> platbu stále povolil, ale signer už nepodpíše nič. Toto je rozdiel oproti prvému kitu: tam sa
> zneužitie dalo len odhaliť, tu sa fyzicky nedá vykonať.

### 6. Send us the result

Send back the two `=== RESULT ===` blocks (tests 1-2 and test 3) and a few words: where you got stuck,
what took longer than expected, and in one sentence what the signer adds over the first kit.

---

# Part B -- instructions for Claude Code

You are helping a beta tester ({{NAME}}) run a short test of Rein's custody tier: a signer process holds
the wallet key, the agent holds only a session token, and every signature needs an engine-signed allow
decision for the exact transfer. {{NAME}} asked you to do this. Work in the current folder. Everything
runs on the Base Sepolia **testnet**; no real money is involved.

Rules:

- The API key below is **intentional**: a testnet key scoped to one test agent. It goes into
  `rein-agent.json` (B1) and nowhere else. **Never put a key or token on a command line** and do not
  print one in chat -- every script reads them from files.
- **Never print the wallet private key** (it lives only in `wallet.json`, read only by `signer.mjs`).
- Do **not** change the logic of the scripts. If something fails, diagnose the ENVIRONMENT (Node
  version, network, TLS/antivirus, npm registry, port 8788 in use) -- not the code -- and report the
  exact error text.
- Each full run makes two $0.001 payments against the agent's **$0.04 per hour** limit. Run the tests
  **once**; if you must rerun within the hour after the earlier kit, a `hour-budget` refusal on test 1
  is correct behaviour, not a bug -- wait an hour.
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
npm install @reinconsole/sdk@{{VERSION}} @reinconsole/signer@{{VERSION}} @reinconsole/x402-rails@{{VERSION}}
```

Must end without `ERR!`. Pin the exact versions shown -- do not use `latest`.

## B3. Create the scripts

Create them exactly as given.

**`signer.mjs`** -- the custody process (the only reader of `wallet.json`)

```js
// The custody process. It is the ONLY program that reads wallet.json.
// Run it in the background and leave it running:  node signer.mjs
//
// It checks the engine's key against the one pinned below, takes the wallet into custody, mints
// ONE capped session for the agent (session.json) and an operator credential
// for the kill switch (signer-admin.json), then serves POST /v1/sign.
import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { SessionSigner, buildSignerServer } from '@reinconsole/signer';

const { engineUrl, agentId } = JSON.parse(readFileSync('rein-agent.json', 'utf8'));
const { privateKey } = JSON.parse(readFileSync('wallet.json', 'utf8'));
const SIGNER_URL = 'http://127.0.0.1:8788';

// The engine's public key, PINNED: it came with this kit, not from the network.
// Every voucher the agent brings must carry a signature that verifies against
// it -- offline, no call back. /health is read only to refuse a mismatch with a
// clear message (a rotated key, or something answering in the engine's place).
const ENGINE_PUBLIC_KEY = `{{ENGINE_PUBLIC_KEY}}`;
const health = await (await fetch(`${engineUrl}/health`)).json();
if (health.publicKey?.trim() !== ENGINE_PUBLIC_KEY.trim()) {
  console.error('signer: the engine at ' + engineUrl + ' does NOT present the pinned key -- refusing to start. Tell the Rein team.');
  process.exit(1);
}
const signer = new SessionSigner({ enginePublicKeyPem: ENGINE_PUBLIC_KEY });
const address = signer.registerWallet(agentId, privateKey);

signer.onEvent((e) => {
  if (e.type === 'signature.released') console.log(`signer: RELEASED a signature for $${e.amount} (decision ${e.decisionId})`);
  if (e.type === 'signature.refused') console.log(`signer: REFUSED [${e.code}] ${e.reason}`);
});

const adminToken = randomBytes(24).toString('hex');
const app = buildSignerServer(signer, { adminToken });
await app.listen({ port: 8788, host: '127.0.0.1' });
writeFileSync('signer-admin.json', JSON.stringify({ signerUrl: SIGNER_URL, adminToken }, null, 2));

// The agent's whole authority: at most $0.002 per signature, $0.003 over the
// session's life, gone after one hour. The token is shown once, here.
const { session, token } = await signer.createSession({
  agentId,
  capAmount: '0.003',
  maxPerPayment: '0.002',
  ttlSeconds: 3600,
});
writeFileSync('session.json', JSON.stringify({ signerUrl: SIGNER_URL, sessionId: session.id, sessionToken: token }, null, 2));

console.log(`signer: wallet ${address} in custody (never leaves this process)`);
console.log(`signer: engine key pinned (shipped with the kit; ${engineUrl}/health matches)`);
console.log(`signer: session ${session.id} minted -> session.json (cap $0.003, max $0.002 per payment, 1 h)`);
console.log(`signer: operator credential -> signer-admin.json`);
console.log(`signer: listening on ${SIGNER_URL} -- leave this running`);
```

**`agent.mjs`** -- the agent (reads `rein-agent.json` and `session.json` only)

```js
// The agent. It reads rein-agent.json (engine, API key) and session.json (the
// session token) and NOTHING else -- there is no wallet key in this process.
// Run:  node agent.mjs            tests 1 and 2 (one paid call, then replays)
//       node agent.mjs --revoked  test 3 (after revoke.mjs)
import { readFileSync } from 'node:fs';
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { createRemoteSessionPayer, SignerError } from '@reinconsole/signer';

const { engineUrl: ENGINE_URL, agentId: AGENT_ID, apiKey: API_KEY } = JSON.parse(readFileSync('rein-agent.json', 'utf8'));
const { signerUrl: SIGNER_URL, sessionToken: TOKEN } = JSON.parse(readFileSync('session.json', 'utf8'));
const PING = 'https://vendor.reinconsole.com/testnet/v1/ping'; // $0.001
const afterRevoke = process.argv.includes('--revoked');

// Every payment goes 402 -> engine decision -> signer -> paid retry. The payer
// forwards each voucher to the signer; this wrapper also keeps the last one so
// test 2 can try to spend it again.
const remote = createRemoteSessionPayer({ signerUrl: SIGNER_URL, sessionToken: TOKEN });
let lastVoucher;
const payer = (requirement, intent, decision) => {
  lastVoucher = { requirement, intent, decision };
  return remote(requirement, intent, decision);
};
const guard = createGuard({ engineUrl: ENGINE_URL, agentId: AGENT_ID, apiKey: API_KEY, networks: ['base-sepolia'], payer });
const plainFetch = globalThis.fetch;
const fetch = guard.wrap();

async function call(url) {
  try {
    return { res: await fetch(url) };
  } catch (err) {
    if (err instanceof PaymentBlockedError) return { blocked: err.decision };
    if (err instanceof SignerError) return { refused: err };
    throw err;
  }
}

// Why an allowed, signed call was not paid: the HTTP status and the vendor's words.
async function whyUnpaid(res) {
  const text = res ? await res.text().catch(() => '') : '';
  let why = text;
  try {
    const j = JSON.parse(text);
    why = [j.code, j.error, j.reason].filter((v) => typeof v === 'string').join(' -- ') || text;
  } catch {}
  return `HTTP ${res?.status ?? 'none'}${why ? `: ${why.replace(/\s+/g, ' ').slice(0, 300)}` : ''}`;
}

// Go to the signer directly, the way a rogue agent would, and report its answer.
async function askSigner(voucher) {
  const res = await plainFetch(`${SIGNER_URL}/v1/sign`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionToken: TOKEN, ...voucher }),
  });
  const body = await res.json().catch(() => ({}));
  return res.ok
    ? `SIGNED (HTTP ${res.status}) -- this is a bug, report it`
    : `REFUSED [${body.code ?? res.status}] ${body.reason ?? ''}`.trim();
}

console.log(`\nRein signer test -- agent ${AGENT_ID}`);
console.log(`Wallet key: not in this process. Session token: ${TOKEN.slice(0, 6)}... (all the agent holds)\n`);

const results = {};

if (!afterRevoke) {
  console.log('--- Test 1: a paid call, signed by the custody process ($0.001) ---');
  const one = await call(PING);
  const r1 = guard.receipts().at(-1);
  if (one.blocked) results.test1 = `REFUSED by Rein -- ${one.blocked.reason}`;
  else if (one.refused) results.test1 = `ALLOWED by Rein, but the signer REFUSED [${one.refused.code}] ${one.refused.message}`;
  else if (one.res?.status === 200 && r1?.settlement?.txHash)
    results.test1 = `PAID AND SETTLED -- signed by the signer, YOUR payment of $0.001: https://sepolia.basescan.org/tx/${r1.settlement.txHash}`;
  else results.test1 = `ALLOWED AND SIGNED, BUT NOT PAID -- ${await whyUnpaid(one.res)} (if the wallet may be empty, run check-balance.mjs)`;
  console.log(`  ${results.test1}`);

  console.log('\n--- Test 2: spend the same voucher again ---');
  if (!lastVoucher) {
    results.test2 = 'skipped (test 1 produced no voucher)';
  } else {
    const { decision } = lastVoucher;
    const again = await askSigner(lastVoucher);
    console.log(`  same voucher, same id:  ${again}`);
    // The engine signs the decision's CONTENT, not its id. A copy under a new
    // (well-formed) id still carries a valid signature -- and must still be refused.
    const newId = decision.id.slice(0, -1) + (decision.id.endsWith('0') ? '1' : '0');
    const reissued = await askSigner({ ...lastVoucher, decision: { ...decision, id: newId } });
    console.log(`  same voucher, new id:   ${reissued}`);
    results.test2 = `${again} / re-id'd copy: ${reissued}`;
  }
  console.log(`  ${results.test2.startsWith('REFUSED') && results.test2.includes('copy: REFUSED') ? 'Both refused.' : 'UNEXPECTED -- report it.'}`);
} else {
  console.log('--- Test 3: the session was revoked; Rein still says yes, the signer says no ($0.001) ---');
  const three = await call(PING);
  if (three.refused)
    results.test3 = `REFUSED by the signer [${three.refused.code}] after Rein ALLOWED (decision ${lastVoucher?.decision.id ?? '?'})`;
  else if (three.blocked) results.test3 = `REFUSED by Rein first -- ${three.blocked.reason} (expected the signer to refuse; report it)`;
  else results.test3 = `PAID (HTTP ${three.res?.status}) -- a revoked session paid; this is a bug, report it`;
  console.log(`  ${results.test3}`);
}

console.log('\n=== RESULT (send this block back) ===');
console.log(`agent:   ${AGENT_ID}`);
for (const [k, v] of Object.entries(results)) console.log(`${k}: ${v}`);
console.log('=====================================\n');
```

**`revoke.mjs`** -- the operator's kill switch

```js
// The operator's kill switch. Reads signer-admin.json (the operator credential)
// and session.json (which session) -- the agent never holds the former.
// Run:  node revoke.mjs
import { readFileSync } from 'node:fs';

const { signerUrl, adminToken } = JSON.parse(readFileSync('signer-admin.json', 'utf8'));
const { sessionId } = JSON.parse(readFileSync('session.json', 'utf8'));

const res = await fetch(`${signerUrl}/v1/sessions/${sessionId}/revoke`, {
  method: 'POST',
  headers: { authorization: `Bearer ${adminToken}` },
});
console.log(res.status === 204 ? `session ${sessionId} REVOKED at the signer` : `revoke failed: HTTP ${res.status} ${await res.text()}`);
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

## B4. The practice wallet

If `wallet.json` already exists (copied from the earlier kit), run `node check-balance.mjs`; it must
print `(FUNDED)`. Otherwise run `node make-wallet.mjs`, show {{NAME}} **only the ADDRESS line**, tell
them to use https://faucet.circle.com (**Base Sepolia** + **USDC**) and reply `funded`, wait for the
reply, then `node check-balance.mjs` until `(FUNDED)` (30 s apart, up to 5 times).

## B5. Start the signer (background)

Run `node signer.mjs` **in the background** and leave it running for the rest of the test. Wait until
its output shows `listening on http://127.0.0.1:8788`. It writes `session.json` (the agent's token)
and `signer-admin.json` (the operator credential). If port 8788 is taken, stop whatever holds it.

## B6. Tests 1 and 2 -- paid call through the signer, then the replays

```
node agent.mjs
```

Expected:

```
test1: PAID AND SETTLED -- signed by the signer, YOUR payment of $0.001: https://sepolia.basescan.org/tx/0x...
test2: REFUSED [decision_replayed] this decision already released a signature / re-id'd copy: REFUSED [decision_replayed] ...
```

A `NOT PAID -- HTTP 402: settle_failed` on test 1 is the public testnet facilitator being busy; the
signature was still released and test 2 still applies. Show {{NAME}} the RESULT block.

## B7. Test 3 -- the kill switch

```
node revoke.mjs
node agent.mjs --revoked
```

Expected: `session ... REVOKED at the signer`, then
`test3: REFUSED by the signer [session_revoked] after Rein ALLOWED (decision dec_...)`.

## B8. Hand-off

Stop the background signer. Show {{NAME}} both RESULT blocks and tell them to send them back with
their feedback (Part A, step 6). Remind them that `wallet.json` is a throwaway practice wallet and the
folder can be deleted after the test.

If any result differs from what is expected above, do not try to fix it -- show {{NAME}} the full
output and tell them to send it as is. An unexpected result is a useful result.
