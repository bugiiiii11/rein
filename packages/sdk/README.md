# @reinconsole/sdk

The demand-side guard of **[Rein](https://github.com/bugiiiii11/rein)** — the control plane for AI agent payments. Wrap your agent's `fetch` once and every [x402](https://www.x402.org) payment is policy-checked, receipted, and observable **before a cent moves**. Non-custodial: Rein governs the authority to spend, never the funds.

> **Status: v0.1 — early open-source infrastructure, live on testnet.** APIs may change before 1.0. See it running: [Rein console](https://app.reinconsole.com).

## Install

```bash
npm install @reinconsole/sdk
# and something to point it at:
npx -p @reinconsole/policy-engine rein-policy-engine   # the rule engine on :8787
```

## Quickstart

```ts
import { createGuard } from '@reinconsole/sdk';

const guard = createGuard({
  engineUrl: 'http://localhost:8787', // @reinconsole/policy-engine (or the durable variant)
  agentId,                            // registered with the engine
  apiKey,                             // required by any engine started with one
});

const fetch = guard.wrap();

// Use it exactly like fetch. When a vendor answers 402:
//  - the guard turns the x402 requirement into a PaymentIntent,
//  - the policy engine evaluates it (budgets, tx caps, allow/deny lists, kill switch),
//  - a signed decision comes back — deny blocks BEFORE any payment exists,
//  - either way you get a Receipt.
const res = await fetch('https://api.vendor.example/answer');
```

## How it behaves

- **402 intercept.** The guard wraps the *base* fetch, underneath any x402 payment library. A blocked paywall never reaches the payment layer; an allowed one flows through, and the payment layer's `X-PAYMENT` retry is attached to the same receipt.
- **Or let it pay.** Pass a `payer` (e.g. the EIP-3009 payer from [`@reinconsole/x402-rails`](https://www.npmjs.com/package/@reinconsole/x402-rails)) and the guard settles allowed payments itself — evaluate → pay → retry, one call.
- **Blocked, your way.** `onBlocked: 'throw'` (default) raises `PaymentBlockedError`; `'respond'` returns a synthetic 402 JSON response for agent loops that inspect instead of catch.
- **Escalation, waited out.** When policy escalates, the engine parks the payment for a human to sign off on. By default the guard blocks immediately and `error.approval.status` tells you it is still `pending` — a signed verdict can still release it out of band. Pass `escalation: { await: true }` and the guard holds the request open until a signature lands, then pays against the engine's follow-up **allow** decision; a rejection or an expiry blocks with the deny. Only wait where a stalled request is acceptable.
- **Task context.** Attach `taskContext` (or scope it per call with `withTask()`) so every decision and receipt says *why* the agent was spending.
- **Receipts either way.** Every paywall encounter — allowed, denied, settled — becomes a `Receipt`; stream them out with `onReceipt`.
- **x402 v1 wire + CAIP-2 ids.** Speaks the hosted-facilitator dialect that [x402.org](https://www.x402.org) still fully supports; network ids accept CAIP-2 forms.

SDK-mode is advisory + observability: an agent that holds its own key can bypass it — and the indexer flags that as **shadow spend**. The session-key signer tier (keys the agent never holds) is the GA enforcement architecture and lives in the [monorepo](https://github.com/bugiiiii11/rein).

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
