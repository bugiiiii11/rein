# @reinconsole/mock-rails

The simulated payment world for **[Rein](https://github.com/bugiiiii11/rein)** — a fully offline twin of the real [x402](https://www.x402.org) rails. Try the whole guard loop — budgets, caps, kill switch, shadow-spend detection — with no accounts, no chain, no funds.

> **Status: v0.1 — early open-source infrastructure.** APIs may change before 1.0. See it running (the live console world runs on these rails): [Rein console](https://reinconsole-production.up.railway.app/).

## Install

```bash
npm install @reinconsole/mock-rails
```

## What's in it

Three pieces, mirroring the production architecture (their live siblings live in [`@reinconsole/x402-rails`](https://www.npmjs.com/package/@reinconsole/x402-rails)):

```ts
import {
  MockLedger,      // the chain: append-only transfers, open to anyone
  MockFacilitator, // x402 settlement (the facilitator's role); payerFor() plugs into the SDK guard
  MockIndexer,     // watches the ledger, reconciles spend against ALLOW decisions,
                   // emits payment.settled — or shadow.spend, the bypass signal
  createMockVendor, // an in-process x402-paywalled vendor to complete the loop
} from '@reinconsole/mock-rails';
```

- **The ledger is honestly open** — anything can append a transfer, which is exactly what makes shadow-spend detection meaningful: a payment that bypassed the guard still lands on the ledger, and the indexer flags it as unreconciled.
- **The facilitator speaks real x402 shapes** — payment headers encode/decode through the same wire schemas the guard parses, so tests exercise the actual parsing paths.
- **The indexer closes the loop** — managed-wallet spend reconciles against engine decisions; everything else becomes a `shadow.spend` event on the bus.
- **`createMockVendor()`** gives you a paywalled endpoint in-process — the standard test/demo counterpart for [`@reinconsole/sdk`](https://www.npmjs.com/package/@reinconsole/sdk)'s guard and [`@reinconsole/gate`](https://www.npmjs.com/package/@reinconsole/gate)'s gated fetch.

The [monorepo](https://github.com/bugiiiii11/rein)'s offline demos (5 scenarios in under 500 ms) are wired entirely on this package.

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
