# @reinconsole/erc8004

[ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) registry integration for **[Rein](https://github.com/bugiiiii11/rein)** — on-chain agent identity and reputation. Reads identity facts from the ratified Identity Registry (an ERC-721; tokenId = the spec's agentId) and turns them into link facts for [`@reinconsole/graph`](https://www.npmjs.com/package/@reinconsole/graph); publishes Rein's graph-derived scores on-chain through the Reputation Registry's `giveFeedback`.

> **Status: v0.3 — early open-source infrastructure, live on testnet.** Verified against the real singleton deployments on Base Sepolia — including a live registration (agentId 7393) carrying its rein-score on-chain. APIs may change before 1.0.

## Install

```bash
npm install @reinconsole/erc8004
```

## What's in it

```ts
import {
  identityRegistryReader,  // viem-backed IdentityRegistryReader (ownerOf / agentWallet / agentURI)
  registerAgent,           // the write path: simulate → write → decode the Registered event
  linkAgentFromRegistry,   // registry facts → graph link facts (agents become erc8004-canonical)
  linkVendorFromRegistry,  // vendors stay host-canonical; identity + treasury fold into the host row
  publishAgentScore,       // graph score → giveFeedback on the Reputation Registry, evidence anchored
  readSummary,             // on-chain score summary (resolves getClients first — see below)
  MockIdentityRegistry, MockReputationRegistry, // in-memory twins for every offline path
} from '@reinconsole/erc8004';
```

- **One identity, one history.** A registered agent's reputation keys by the canonical id `eip155:{chainId}:{registry}/{tokenId}` (formatted by `@reinconsole/core`); its local id and every wallet — `ownerOf`, the verified `agentWallet` — fold in as aliases. Two deployments claiming the same registration merge into one history; key rotation never splits a score.
- **Foreign-registry guard.** A document naming another chain's or another registry's id is never resolved against ours; stale docs degrade to local linking (lenient), network errors stay loud — a dead RPC is never misread as "not registered".
- **Scores go on-chain.** `scoreToFeedback` maps a 0–100 graph score to `giveFeedback` (value at decimals 0, `rein-score` tag, confidence tag); evidence documents are keccak-anchored self-verifying `data:` URIs — nothing to host.
- **Deployment-verified quirks handled.** `getAgentWallet` returns the zero address rather than reverting; the live Base Sepolia Reputation Registry requires an explicit client list for `getSummary` (`readSummary` resolves `getClients` first). Both learned against the real contracts, not the repo source.
- **Offline twins included.** `MockIdentityRegistry` / `MockReputationRegistry` mirror the deployed semantics (1-based feedback indexes, self-feedback ban, zero-address fidelity) for tests and demos.

Singleton deployment addresses ship as constants (`BASE_SEPOLIA_REGISTRY`, `IDENTITY_REGISTRY_MAINNET`, `BASE_SEPOLIA_REPUTATION`, …).

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
