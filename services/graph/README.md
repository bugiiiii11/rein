# @reinconsole/graph

Phase 3 of **[Rein](https://github.com/bugiiiii11/rein)** — the reputation graph. Guard receipts say what agents tried to spend; gate receipts say what vendors actually earned. The graph listens to both, scores every vendor and payer it has evidence on, and feeds the scores back into enforcement on both sides of the wire.

> **Status: v0.2 — early open-source infrastructure, live on testnet.** APIs may change before 1.0. See the live scoreboard: [Rein console](https://app.reinconsole.com).

## Install

```bash
npm install @reinconsole/graph
```

## Quickstart

```ts
import { ReputationGraph, payerCheck } from '@reinconsole/graph';

const graph = new ReputationGraph().observe(engine).observe(indexer).observe(gate);

// Agent side: pushed scores make `vendorReputationLt` policies fire.
await graph.syncVendors(engine.spend);

// Vendor side: confidently-bad wallets are turned away at the door.
createGate({ screen: { check: payerCheck(graph, { denyBelow: 40 }) }, /* ... */ });
```

## How it scores

- **Evidence, not vibes.** Per-subject history accumulates straight off the event buses — settlements, refusals (replays weighted heaviest), shadow spends, settled-money edges between counterparties, manual dispute/endorsement reports. Scores are **never stored**: they recompute from raw evidence on demand, so every score is explainable down to the counts behind it.
- **Five components + confidence.** Settlement reliability, dispute hygiene, volume, longevity, and one-hop counterparty quality, blended 0–100. Confidence is first-class: thin or brand-new history yields low confidence, not a fake number — and same-day evidence is discounted until it ages.
- **Unknown is not bad.** The evaluator never fires `vendorReputationLt` without data, `syncVendors` withholds scores under the confidence floor, and `payerCheck` passes wallets it knows nothing about. A newcomer is served; a *confidently* bad actor is refused.
- **No-fault refusals carry no evidence.** Rate limits, velocity caps, and rails outages at one vendor's gate never bleed into a payer's global score.
- **One identity, one history.** `graph.link(canonical, alias)` merges subjects across id spaces — an agent's engine ULID, its paying wallets, its on-chain [ERC-8004](https://www.npmjs.com/package/@reinconsole/erc8004) identity — so evidence follows the party, not the key. Key rotation never splits a score.
- **Run it as a service.** `buildGraphServer()` — remote producers `POST /v1/events`, anyone reads `GET /v1/scores/:kind/:subject` and gets the score *and* the evidence behind it. Pass `{ auth }` (an `ApiKeyAuth` from `@reinconsole/core/auth`, or set `REIN_GRAPH_API_KEY`) and the write routes demand a key holding the `report` scope while reads stay open; without one the server binds loopback and refuses a public bind. The durable variant (evidence survives restarts) lives in the [monorepo](https://github.com/bugiiiii11/rein) (`@reinconsole/store`).

Scoring weights are deliberately transparent v0.1 heuristics (`DEFAULT_WEIGHTS`, overridable) — scores are pure functions of the evidence ledger, so the model can evolve without migrations.

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
