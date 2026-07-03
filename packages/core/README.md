# @rein/core

Canonical [zod](https://zod.dev) schemas and shared types for **[Rein](https://github.com/bugiiiii11/rein)** — the control plane for AI agent payments. This package is the single source of truth for DB rows, API payloads, and SDK types across the whole stack.

> **Status: v0.1 — early open-source infrastructure, live on testnet.** APIs may change before 1.0. See the stack running live: [Rein console](https://reinconsole-production.up.railway.app/).

## Install

```bash
npm install @rein/core
```

## What's in it

- **The domain schemas** — `Agent`, `Policy`, `PaymentIntent`, `Decision`, `Receipt`, `GateReceipt`, `ReinEvent`, and the id types (`AgentId`, `OrgId`, …) behind them. Everything that crosses a Rein boundary is one of these.
- **Float-free money** — decimal-string amount math; no `0.1 + 0.2` in anything that touches funds.
- **Canonical forms** — the exact byte layouts that `intentHash` and the decision hash chain commit to (`canonical.ts`). Pure and browser-safe by design: no `node:crypto` in this package.
- **ERC-8004 ids** — `formatErc8004Id` / `parseErc8004Id` for the canonical `eip155:{chainId}:{registry}/{tokenId}` agent identity format (lowercased, normalized, bigint-safe).
- **Shared glob matcher** — `globMatch` / `globMatchAny`, used by policy targeting and gate route pricing.

```ts
import { PaymentIntent, Decision, formatErc8004Id } from '@rein/core';

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
| [`@rein/sdk`](https://www.npmjs.com/package/@rein/sdk) | Guard — wrap your agent's fetch; every x402 payment policy-checked first |
| [`@rein/policy-engine`](https://www.npmjs.com/package/@rein/policy-engine) | The rule engine with signed, hash-chained decisions |
| [`@rein/gate`](https://www.npmjs.com/package/@rein/gate) | Vendor-side x402 monetization middleware |
| [`@rein/graph`](https://www.npmjs.com/package/@rein/graph) | Explainable reputation over agents and vendors |
| [`@rein/x402-rails`](https://www.npmjs.com/package/@rein/x402-rails) | Real rails: EIP-3009 payer + x402.org facilitator client (Base Sepolia) |
| [`@rein/mock-rails`](https://www.npmjs.com/package/@rein/mock-rails) | Offline twin: mock facilitator, ledger, indexer |
| [`@rein/erc8004`](https://www.npmjs.com/package/@rein/erc8004) | ERC-8004 identity + reputation registry integration |

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
