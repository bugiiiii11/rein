# Rein beta -- tester guide

Thank you for testing. This takes about 20 minutes and costs nothing.

You do not need to know anything about AI agents, crypto, or Rein to do it. Everything below is
copy-paste. If something does not match what this page says, that is exactly the kind of thing we
want to hear about -- send it back rather than trying to fix it.

## What you are testing, in three sentences

Software "agents" can now buy things on their own -- an API call, a dataset, a search result --
paying a few cents at a time without a human clicking anything. That is useful and also alarming,
because nobody wants a program with an open wallet. Rein is the thing in between: it decides,
before any money moves, whether a given purchase is allowed, and keeps a receipt of every decision.

You will play the part of the agent. You will make a purchase that is allowed, and one that is
refused, and see both appear on a dashboard.

**All money in this test is fake.** It is "testnet" currency, issued free, worth nothing, on a
practice network. You cannot spend real money here even by mistake, and we never see or hold your
funds.

## What you need

- A computer with a terminal (Terminal on Mac, PowerShell or Command Prompt on Windows).
- **Node.js version 22 or newer.** Check by running `node --version`. If it prints something lower
  than `v22`, or "command not found", install it from <https://nodejs.org> (choose the "LTS"
  button), then close and reopen your terminal.
- The invitation e-mail we sent you. It contains two values you will paste in: an **agent ID**
  starting `agt_` and an **API key** starting `rk_`.

---

## Step 1 -- make a folder and install the tools

Copy these four lines into your terminal, one at a time. The last one takes a minute.

```
mkdir rein-beta
cd rein-beta
npm init -y
npm install @reinconsole/sdk @reinconsole/x402-rails
```

You will see a lot of output. As long as the last line does not say `ERR!`, it worked.

## Step 2 -- save the test script

In the `rein-beta` folder, create a file called **`rein-test.mjs`** and paste all of this into it.
Any text editor works -- on Mac you can run `open -e rein-test.mjs`; on Windows,
`notepad rein-test.mjs` and click Yes when it offers to create the file.

```js
// Rein beta test script. Run it with:  node rein-test.mjs
//
// Paste the values from your invitation e-mail between the quotes below.
// Nothing else in this file needs changing.

const ENGINE_URL = 'https://engine.reinconsole.com';
const AGENT_ID = 'PASTE_YOUR_AGENT_ID_HERE';
const API_KEY = 'PASTE_YOUR_API_KEY_HERE';

// Leave this empty for the first run. Step 4 tells you what to put here.
const WALLET_PRIVATE_KEY = '';

// ---------------------------------------------------------------------------
// You do not need to read past this line.
// ---------------------------------------------------------------------------
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { createX402Payer } from '@reinconsole/x402-rails';

const PING = 'https://vendor.reinconsole.com/testnet/v1/ping';
const SCORES = 'https://vendor.reinconsole.com/testnet/v1/scores/vendor/api.example.com';

for (const [name, value] of [['AGENT_ID', AGENT_ID], ['API_KEY', API_KEY]]) {
  if (!value || value.startsWith('PASTE_')) {
    console.error(`\nStop: ${name} is still the placeholder. Open rein-test.mjs and paste the value from your invitation.\n`);
    process.exit(1);
  }
}
if (WALLET_PRIVATE_KEY && !/^0x[0-9a-fA-F]{64}$/.test(WALLET_PRIVATE_KEY)) {
  console.error('\nStop: WALLET_PRIVATE_KEY must start with 0x and be 64 characters after it.\n');
  process.exit(1);
}

// 'base-sepolia' is the practice network. It is listed here and nowhere else,
// which is what stops this key ever paying on the real-money network.
const base = { engineUrl: ENGINE_URL, agentId: AGENT_ID, apiKey: API_KEY, networks: ['base-sepolia'] };
const paid = Boolean(WALLET_PRIVATE_KEY);

console.log(`\nRein beta test -- agent ${AGENT_ID}`);
console.log(paid ? 'Wallet found: payments will go through (practice money).\n' : 'No wallet set: nothing can be paid. That is correct for the first run.\n');

const guard = createGuard(paid ? { ...base, payer: createX402Payer({ privateKey: WALLET_PRIVATE_KEY }) } : base);
const fetch = guard.wrap();

async function call(url) {
  try {
    return { res: await fetch(url) };
  } catch (err) {
    if (err instanceof PaymentBlockedError) return { blocked: err.decision };
    throw err;
  }
}

console.log('--- Test 1: can you buy something? ---');
const one = await call(PING);
const r1 = guard.receipts().at(-1);
if (one.blocked) {
  console.log(`  Answer: REFUSED -- ${one.blocked.reason}`);
  console.log('  That still counts: the engine decided. If it mentions hour-budget, this hour\'s');
  console.log('  allowance is already spent -- wait an hour and run again.');
} else if (!paid && one.res?.status === 402 && r1?.outcome === 'allow') {
  console.log('  Answer: ALLOWED BUT UNPAID. Permission granted; you have no wallet, so nothing moved.');
  console.log(`  Decision ${r1.decisionId ?? '(no id)'} was recorded. Send us that id.`);
} else if (paid && one.res?.status === 200 && r1?.settlement?.txHash) {
  console.log('  Answer: PAID AND SETTLED. Practice money actually moved.');
  console.log(`  Proof: https://sepolia.basescan.org/tx/${r1.settlement.txHash}`);
} else if (paid && one.res?.status === 402 && r1?.outcome === 'allow') {
  console.log('  Answer: ALLOWED, BUT THE PAYMENT DID NOT GO THROUGH.');
  console.log('  Permission was granted and your wallet was used, but nothing settled. Almost');
  console.log('  always this means the wallet has no practice money in it yet:');
  console.log('    - the faucet has not arrived (give it a minute and run again), or');
  console.log('    - the faucet sent to a different network -- it must be Base Sepolia, token USDC, or');
  console.log('    - the address you funded is not the one this private key belongs to.');
  console.log('  Re-run make-wallet.mjs and check the address matches what you gave the faucet.');
} else {
  console.log(`  Unexpected: status ${one.res?.status}, outcome ${r1?.outcome ?? 'none'}.`);
  console.log('  Copy this whole output and send it back -- that is a useful result, not a mistake.');
}

if (paid) {
  console.log('\n--- Test 2: does your spending limit stop you? ---');
  console.log('  Buying a $0.005 item over and over until the $0.04 hourly limit refuses one.');
  let denied;
  let settledAny = false;
  for (let i = 1; i <= 12 && !denied; i += 1) {
    const c = await call(SCORES);
    if (c.blocked) {
      console.log(`  call ${i}: REFUSED -- ${c.blocked.reason}`);
      if (c.blocked.outcome === 'deny') denied = c.blocked;
    } else {
      // "Allowed" and "paid" are not the same thing, and saying so would let an
      // empty wallet look like a successful run.
      const tx = guard.receipts().at(-1)?.settlement?.txHash;
      if (tx) settledAny = true;
      console.log(`  call ${i}: allowed, ${tx ? `PAID (${tx.slice(0, 10)}...)` : 'but NOT paid -- wallet is empty'}`);
    }
  }
  console.log(denied
    ? '\n  Answer: REFUSED, as designed. No payment was even prepared.'
    : '\n  Answer: 12 calls and nothing was refused. Send this output back -- that is a bug.');
  if (denied && !settledAny) {
    console.log('  But note: none of the calls above actually paid, so your wallet is still empty.');
    console.log('  The refusal is real; the purchases were not. Fund the wallet and run again.');
  }
}

console.log('\nDone. Copy everything above and send it back to us.\n');
```

Now replace `PASTE_YOUR_AGENT_ID_HERE` and `PASTE_YOUR_API_KEY_HERE` with the two values from your
invitation e-mail. Keep the quotes around them. Save the file.

## Step 3 -- first run: permission without payment

```
node rein-test.mjs
```

You should see:

```
  Answer: ALLOWED BUT UNPAID. Permission granted; you have no wallet, so nothing moved.
```

That is the whole idea in one line. You asked to buy something, Rein said yes, and because you have
no wallet yet, nothing was paid. The decision was still recorded.

**Send us this output.** That is checkpoint one.

## Step 4 -- get a practice wallet and some practice money

A "wallet" here is just a long secret number that can sign for payments. You are about to create a
throwaway one. It will only ever hold free practice money.

Create a file **`make-wallet.mjs`** in the same folder:

```js
import { generateWallet } from '@reinconsole/x402-rails';
const w = generateWallet();
console.log('\nAddress (give this to the faucet):\n  ' + w.address);
console.log('\nPrivate key (paste into rein-test.mjs):\n  ' + w.privateKey + '\n');
```

Run it:

```
node make-wallet.mjs
```

It prints two lines. Then:

1. Go to <https://faucet.circle.com>
2. Choose network **Base Sepolia** and token **USDC**.
3. Paste the **Address** from above and request the funds. They arrive in under a minute. You do
   not need any other currency -- the transaction fees are covered for you.
4. Open `rein-test.mjs` and paste the **Private key** into the `WALLET_PRIVATE_KEY` line, between
   the quotes. Save.

This key is disposable and only ever touches practice money, so there is nothing to protect. Do not
reuse a wallet you use for anything real.

## Step 5 -- second run: a real (practice) purchase, and a refusal

```
node rein-test.mjs
```

This time you should see two things:

- **Test 1** -- `PAID AND SETTLED`, with a link. Click it: that is the payment, recorded publicly
  and permanently.
- **Test 2** -- a handful of allowed purchases, then `REFUSED -- denied by: hour-budget`. Your
  allowance is $0.04 per hour and each item costs $0.005, so somewhere around the eighth one is
  turned down. It is refused *before* any payment is prepared -- the money was never at risk.

**Send us this output too.** That is checkpoint two, and it is the one that matters most.

## Step 6 -- check the payment really happened

Click the `https://sepolia.basescan.org/tx/...` link the script printed in step 5. That is a public
record of your payment, written by the network rather than by us: the amount, the two wallets, the
timestamp. Nothing we run can change or remove it.

That is the point worth taking away. You do not have to trust our dashboard that the payment
happened, or that it was for the amount we said -- you can check it somewhere we do not control.

(Your own decisions are private to your organisation, so the public demo dashboard at
app.reinconsole.com shows our test agents rather than yours. We can see yours from our side, and
the receipts in your terminal are the same records.)

---

## What to send back

Paste the terminal output from steps 3 and 5, and then tell us, in whatever words you like:

1. Where did you get stuck, confused, or have to guess?
2. Did anything take longer than you expected?
3. At the end, could you explain in one sentence what Rein does? If not, that is our failure, not
   yours -- please say so.
4. Did anything feel untrustworthy or unclear about being told "this is safe"?

Rough notes are more useful than polished ones.

## If something goes wrong

| What you see | What it means |
|---|---|
| `command not found: node` | Node.js is not installed, or the terminal needs reopening after installing it. |
| `SyntaxError` mentioning `import` | Node is older than 22. Check `node --version`. |
| `Stop: AGENT_ID is still the placeholder` | The values from the invitation have not been pasted in yet. |
| `REFUSED -- denied by: hour-budget` on the *first* test | The hourly allowance is already spent. Wait an hour, or tell us and we will raise it. |
| `ALLOWED, BUT THE PAYMENT DID NOT GO THROUGH` | The wallet is empty. The faucet has not landed yet, or it funded a different network or a different address. The script tells you what to check. |
| `allowed, but NOT paid -- wallet is empty` in Test 2 | Same cause. The refusal at the end is still real, but nothing was purchased -- fund the wallet and run again. |
| `401` or `403` | The API key is wrong, truncated, or has been revoked. Send us the message. |
| Test 1 says `PAID` but prints no link | Tell us. That combination should not happen. |
| The faucet will not send | It rate-limits per address per day. Run `make-wallet.mjs` again for a fresh address. |

Anything else: send us the output. There is no wrong result from a test.
