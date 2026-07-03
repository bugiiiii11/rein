# @reinconsole/core

Canonical [zod](https://zod.dev) schemas and shared types for **[Rein](https://github.com/bugiiiii11/rein)** — the control plane for AI agent payments. This package is the single source of truth for DB rows, API payloads, and SDK types across the whole stack.

> **Status: v0.1 — early open-source infrastructure, live on testnet.** APIs may change before 1.0. See the stack running live: [Rein console](https://reinconsole-production.up.railway.app/).

## Install

```bash
npm install @reinconsole/core
```

## What's in it

- **The domain schemas** — `Agent`, `Policy`, `PaymentIntent`, `Decision`, `Receipt`, `GateReceipt`, `ReinEvent`, and the id types (`AgentId`, `OrgId`, …) behind them. Everything that crosses a Rein boundary is one of these.
- **Float-free money** — decimal-string amount math; no `0.1 + 0.2` in anything that touches funds.
- **Canonical forms** — the exact byte layouts that `intentHash` and the decision hash chain commit to (`canonical.ts`). Pure and browser-safe by design: no `node:crypto` in this package.
- **ERC-8004 ids** — `formatErc8004Id` / `parseErc8004Id` for the canonical `eip155:{chainId}:{registry}/{tokenId}` agent identity format (lowercased, normalized, bigint-safe).
- **Shared glob matcher** — `globMatch` / `globMatchAny`, used by policy targeting and gate route pricing.

```ts
import { PaymentIntent, Decision, formatErc8004Id } from '@reinconsole/core';

const intent = PaymentIntent.parse(untrustedInput); // validated, typed
const id = formatErc8004Id({
  chainId: 84532,
  registry: '0x8004A818BFB912233c491871b3d84c89A494BD9e',
  tokenId: 7393n,
}); // "eip155:84532:0x8004a818…bd9e/7393"
```

## The Rein stack

| Package | Role |
| --- | --- |
| [`@reinconsole/sdk`](https://www.npmjs.com/package/@reinconsole/sdk) | Guard — wrap your agent's fetch; every x402 payment policy-checked first |
| [`@reinconsole/policy-engine`](https://www.npmjs.com/package/@reinconsole/policy-engine) | The rule engine with signed, hash-chained decisions |
| [`@reinconsole/gate`](https://www.npmjs.com/package/@reinconsole/gate) | Vendor-side x402 monetization middleware |
| [`@reinconsole/graph`](https://www.npmjs.com/package/@reinconsole/graph) | Explainable reputation over agents and vendors |
| [`@reinconsole/x402-rails`](https://www.npmjs.com/package/@reinconsole/x402-rails) | Real rails: EIP-3009 payer + x402.org facilitator client (Base Sepolia) |
| [`@reinconsole/mock-rails`](https://www.npmjs.com/package/@reinconsole/mock-rails) | Offline twin: mock facilitator, ledger, indexer |
| [`@reinconsole/erc8004`](https://www.npmjs.com/package/@reinconsole/erc8004) | ERC-8004 identity + reputation registry integration |

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
