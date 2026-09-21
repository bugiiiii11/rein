# Rein agent quickstart

Rein governs an agent's authority to spend. It never holds the funds.

This page is written to be executed, not read. Everything below runs offline — no accounts, no
chain, no funds. Node >= 22 is the only prerequisite.

There are two integration paths. Pick one:

- **MCP** — the agent's harness gets a spend-governed `fetch` tool. No code. Start here if the agent
  runs in Claude Code, or any MCP-capable harness.
- **SDK** — wrap the agent's own `fetch` in code. Start here if the agent is a program you control.

Both need a policy engine. Run one yourself (step 1), or use the hosted one (Path 0).

---

## Path 0 — the hosted engine (invited)

If you were invited to the beta you already have an org, an agent and a key, and steps 1 and 2 are
done for you. The engine is `https://engine.reinconsole.com`; the key is scoped to your org and
narrowed to your one agent, so it can submit that agent's payments and nothing else.

```json
{
  "mcpServers": {
    "rein": {
      "command": "npx",
      "args": ["-y", "@reinconsole/mcp"],
      "env": {
        "REIN_ENGINE_URL": "https://engine.reinconsole.com",
        "REIN_ENGINE_API_KEY": "rk_... (from your invitation)",
        "REIN_AGENT_ID": "agt_01J... (from your invitation)",
        "REIN_NETWORK_PROFILE": "testnet"
      }
    }
  }
}
```

The SDK path is the same four values passed to `createGuard` (`engineUrl`, `apiKey`, `agentId`,
`networks: ['base-sepolia']`).

Then, in order:

1. **Advisory.** With no wallet key, call `rein_fetch` on
   `https://vendor.reinconsole.com/testnet/v1/ping`. The vendor quotes $0.001; the engine decides;
   the tool returns `ALLOWED_BUT_UNPAID`. The decision is already on
   [app.reinconsole.com](https://app.reinconsole.com), and nothing moved.
2. **Funded.** Get free testnet USDC for a wallet at <https://faucet.circle.com> (pick Base Sepolia;
   no ETH needed, the facilitator pays gas). Add `REIN_PAYER_PRIVATE_KEY`. The same call now
   settles, and `rein_receipts` shows it settled.
3. **Refused.** Your starter policy caps a single payment; ask for
   `https://vendor.reinconsole.com/testnet/v1/scores/vendor/api.example.com` ($0.005) until the
   rolling budget refuses one, and read the `DENIED` reason back from the tool error.

`REIN_NETWORK_PROFILE=testnet` is not decoration: the engine cannot tell Base from Base Sepolia,
so this is what keeps a testnet key from ever paying a mainnet 402. Leave it set.

---

## 1. Start the policy engine

The engine is the referee: it holds agents, policies, and a hash-chained, signed decision log.
Leave it running in its own terminal.

```
npx -p @reinconsole/policy-engine rein-policy-engine
```

```
[rein] WARNING: no REIN_ENGINE_API_KEY set — binding 127.0.0.1 only. Set one before exposing this engine.
[rein] policy-engine listening on http://127.0.0.1:8787 (auth: none)
```

Unkeyed, it binds loopback only, and says so. That is deliberate: a public bind without an API key
is a startup error, not a warning.

## 2. Register an agent and write a policy

```js
// setup.mjs — npm install @reinconsole/sdk @reinconsole/core
import { newId } from '@reinconsole/core';
import { EngineClient } from '@reinconsole/sdk';

const client = new EngineClient({ baseUrl: 'http://127.0.0.1:8787' });

const agent = await client.registerAgent({
  orgId: newId('org'),
  name: 'research-agent',
  labels: ['research'],
  wallets: [{ chain: 'base', address: '0xYourAgentWallet', mode: 'sdk' }],
});

await client.addPolicy({
  policyId: 'starter-policy',
  appliesTo: { agents: [agent.id] },
  rules: [
    { id: 'tx-cap', deny: { amountGt: '0.50' } },
    { id: 'hour-budget', deny: { rollingSum: { window: '1h', gt: '0.04' } } },
  ],
  default: 'allow',
});

console.log(agent.id); // agt_01J... — you need this for either path below
```

Rule evaluation is **deny > escalate > allow > default**, first-applicable policy by `appliesTo`.
An explicit deny always wins.

---

## Path A — MCP

Add the server to the harness's MCP config. It speaks for exactly one agent.

```json
{
  "mcpServers": {
    "rein": {
      "command": "npx",
      "args": ["-y", "@reinconsole/mcp"],
      "env": {
        "REIN_ENGINE_URL": "http://127.0.0.1:8787",
        "REIN_AGENT_ID": "agt_01J..."
      }
    }
  }
}
```

That is **advisory mode**: paywalls are evaluated against policy and reported, and nothing is ever
paid. Add `REIN_PAYER_PRIVATE_KEY` (the agent wallet's key) to settle allowed payments.

Five tools appear:

| Tool | Read-only | What it answers |
|---|---|---|
| `rein_fetch` | no | Fetch a URL, paying for it only if policy allows. |
| `rein_status` | yes | What rules govern this agent, and where it stands against them. |
| `rein_receipts` | yes | What it has paid, and whether those payments settled. |
| `rein_escalations` | yes | Which of its payments are parked awaiting a human. |
| `rein_heartbeat` | no | Report the agent alive, for dead-man monitoring. |

Use `rein_fetch` instead of a plain fetch for any request that might be paid. A refusal comes back
as a tool error carrying `DENIED` (final) or `ESCALATED` (parked for a human signature). Neither can
be retried into an approval.

---

## Path B — SDK

```js
// agent.mjs — npm install @reinconsole/sdk @reinconsole/mock-rails
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { MockLedger, MockFacilitator, createMockVendor } from '@reinconsole/mock-rails';

// A simulated x402 world: a ledger, a facilitator, and a vendor charging $0.01 a call.
const ledger = new MockLedger();
const facilitator = new MockFacilitator({ ledger, name: 'mock-facilitator' });
const vendor = createMockVendor({ facilitator, atomicPrice: '10000', payTo: '0xVendorTreasury' });

const guard = createGuard({
  engineUrl: 'http://127.0.0.1:8787',
  agentId: 'agt_01J...',
  fetch: vendor.fetch,                          // swap for globalThis.fetch against real vendors
  payer: facilitator.payerFor('0xYourAgentWallet'), // omit for advisory mode
});

const fetch = guard.wrap();                     // this is the whole integration

for (let i = 1; i <= 5; i++) {
  try {
    await fetch('https://api.data.test/v1/query');
    console.log(`call ${i}  ALLOW`);
  } catch (err) {
    if (!(err instanceof PaymentBlockedError)) throw err;
    console.log(`call ${i}  ${err.decision.outcome.toUpperCase()}  ${err.decision.reason}`);
  }
}
```

Four calls pass. The fifth is refused by `hour-budget` — before any payment is constructed. Nothing
was signed, sent, or refunded.

---

## What to know before shipping

**Non-custodial.** Funds never pass through Rein. It governs authority, not money.

**Fail-closed.** An unreachable engine denies rather than allows. A 402 offering nothing Rein can
govern is refused rather than paid.

**A denial is final; an escalation is not a denial.** `escalate` parks the payment for a human to
release with an ed25519 signature over the decision, and it expires into a deny. No click, channel,
or tool call substitutes for that signature — which is why nothing in the agent's own surface can
approve its own payment.

**Attribute spend to a task.** Pass `taskId` (`guard.withTask({ taskId }, fn)`, or the `taskId`
argument to `rein_fetch`) and a `taskBudget` rule can cap one unit of work. An intent carrying no
`taskId` never triggers a budget — require attribution explicitly with the `taskIdMissing`
predicate if you need it.

**Report settlements, or reconciliation reads every allowance as a gap.** The SDK guard does this
for you by default. A reporter that carries the settled amount also lets the engine catch the other
failure: a settlement for MORE than the decision allowed is an `overspent` row, listed first.

**A testnet-profile key never pays mainnet.** The engine maps Base and Base Sepolia onto one chain,
so a policy cannot separate them; `REIN_NETWORK_PROFILE` (default `testnet`) does, in the guard
and again in the payer. A mainnet 402 is refused before a signature exists.

## Policy vocabulary

Conditions: `amountGt`, `rollingSum: { window, gt }`, `txCount: { window, gt }`, `vendorHostIn`,
`resourceIn` (path globs), `vendorFirstSeen`, `vendorReputationLt`, `amountVsResourceMedian`,
`taskBudget: { gt }`, `taskIdMissing`.

Each rule carries exactly one of `allow` / `deny` / `escalate`.

Behavioral breakers sit alongside the rules and escalate rather than deny:

```js
breakers: [{ id: 'velocity', window: '24h', txCount: 20, valueCap: '5.00' }]
```

A breaker trips on the payment that *would* carry the agent past the envelope, never retrospectively,
and never denies on its own.

## Next

- Full package list and concepts: <https://reinconsole.com/llms.txt>
- The same runbook with the vendor side: <https://reinconsole.com/get-started.html>
- A live console over a seeded scenario: <https://app.reinconsole.com>
