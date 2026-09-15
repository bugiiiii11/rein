# @reinconsole/gate

The supply side of **[Rein](https://github.com/bugiiiii11/rein)** — vendor-side [x402](https://www.x402.org) monetization middleware. Price your routes once and every payment into your API is quoted, cross-checked, screened, rate-limited, settled, and receipted before your handler runs.

> **Status: v0.2 — early open-source infrastructure, live on testnet.** Verified live on Base Sepolia against the hosted x402.org facilitator. APIs may change before 1.0. See it running: [Rein console](https://app.reinconsole.com).

## Install

```bash
npm install @reinconsole/gate
```

## Quickstart

```ts
import { createGate, gateMiddleware, facilitatorClientRails } from '@reinconsole/gate';

const gate = createGate({
  routes: [
    { path: '/api/answer', price: '0.05', description: 'one research answer' },
    { path: '/api/premium/*', method: 'POST', price: '0.25' },
  ],
  rails: facilitatorClientRails(facilitator), // or mockFacilitatorRails(...) offline
  payTo: '0xYourTreasury…',
  network: 'base-sepolia',
  asset: USDC_ADDRESS,
  screen: { denyPayers: ['0xKnownMule…'] },
});

app.use(gateMiddleware(gate)); // Express, or wrap any node:http handler
```

In-process instead? `createGatedFetch(...)` turns the same gate into a `fetch`-shaped vendor for tests and agent loops.

## What it does that a bare 402 snippet doesn't

- **Quote consistency.** A presented payment must match the gate's own quote — scheme, network, amount, recipient — before any facilitator round-trip. Underpayment is refused at the door.
- **Payer screening.** Allow/deny lists plus a dynamic `screen.check` hook (reputation plugs in here — see [`@reinconsole/graph`](https://www.npmjs.com/package/@reinconsole/graph)'s `payerCheck`), checked *before* verify/settle, so a blocked payer costs you nothing.
- **Replay protection.** Each payment settles once; the slot is burned before the async legs, so two concurrent copies can't both pass.
- **Velocity caps + rate limiting.** Per-payer settled-spend caps (`maxPayments` / `maxAmount`) and a sliding-window presentation limiter (`maxAttempts` → 429 + `Retry-After`). Throttle refusals happen before the replay burn, so a held payment clears once the window slides.
- **Honest rails failures.** Provably-unsent transport failures are retried, then refused `rails_unavailable` with the replay slot released; an ambiguous settle refuses `settle_unknown` with the slot kept burned — the money may have moved, and the gate never guesses.
- **Receipts + revenue.** Every settlement becomes a `GateReceipt`; `gate.stats()` aggregates revenue by asset, route, and payer; `quoted` / `settled` / `refused` events stream on the bus.
- **x402 v2 dual-stack.** Accepts both payment dialects always; `advertiseV2` adds the v2 `PAYMENT-REQUIRED` header quote beside the v1 body; CAIP-2 and v1 network ids normalize in consistency checks.
- **Pluggable rails.** The same gate runs against the mock facilitator ([`@reinconsole/mock-rails`](https://www.npmjs.com/package/@reinconsole/mock-rails)) or the real hosted facilitator ([`@reinconsole/x402-rails`](https://www.npmjs.com/package/@reinconsole/x402-rails)) — a two-method structural seam.

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
