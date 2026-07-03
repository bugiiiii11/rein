# @reinconsole/x402-rails

The real payment rails for **[Rein](https://github.com/bugiiiii11/rein)** — [x402](https://www.x402.org) on Base Sepolia. An EIP-3009 payer that signs real USDC payments (gasless for the agent — the facilitator submits the tx), an HTTP client for the hosted x402.org facilitator, a strict x402-v1 in-process vendor, and an on-chain indexer that reconciles USDC transfers back to the exact intents the policy engine allowed.

> **Status: v0.1 — early open-source infrastructure, live on testnet.** Real USDC settled on Base Sepolia through the hosted facilitator — no API key needed. APIs may change before 1.0.

## Install

```bash
npm install @reinconsole/x402-rails
```

## What's in it

```ts
import {
  createX402Payer,     // EIP-3009/EIP-712 signer — plugs into @reinconsole/sdk's guard as its `payer`
  FacilitatorClient,   // verify/settle against the hosted x402.org facilitator
  OnchainIndexer,      // getLogs polling; reconciles transfers to intents via the nonce memo
  createRealVendor,    // strict x402-v1 in-process vendor
  intentNonce,         // keccak256(intent.id) — the on-chain memo
  generateWallet, createBaseSepoliaClient, getUsdcBalance, // wallet + chain helpers
} from '@reinconsole/x402-rails';
```

- **Gasless for the agent.** The payer signs an EIP-3009 `transferWithAuthorization`; the facilitator submits the transaction and pays gas. A funded USDC balance is all the agent wallet needs ([free testnet USDC](https://faucet.circle.com)).
- **An on-chain memo, no fuzzy matching.** The authorization nonce is derived as `keccak256(intent.id)`; USDC emits it back in `AuthorizationUsed` on settlement, so the indexer reconciles each transfer to the exact intent the engine allowed — and flags everything else from managed wallets as **shadow spend**.
- **The hosted facilitator, for free.** `FacilitatorClient` speaks the x402.org dialect (`DEFAULT_FACILITATOR_URL`, no API key). The same client powers [`@reinconsole/gate`](https://www.npmjs.com/package/@reinconsole/gate)'s real-rails settlement via `facilitatorClientRails`.
- **Wire schemas included** — payment payloads, verify/settle responses, header codecs; all zod-validated.

Behind a TLS-intercepting proxy or antivirus, point Node at your local root CA (`NODE_EXTRA_CA_CERTS`) before any live run.

The [monorepo](https://github.com/bugiiiii11/rein)'s Sepolia demos run this end to end — a guarded $0.01 payment settled on-chain, then a guard-bypassing payment caught by the indexer.

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
