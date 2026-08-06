# Rein

**The control plane for AI agent payments.** Rein sets the rules, watches every payment, and scores every counterparty — so agents can transact at machine speed without machine-speed losses.

Rein is developer tooling and middleware for the agentic payments economy (the [x402](https://www.x402.org) / ERC-8004 stack). It is **non-custodial**: Rein governs an agent's _authority to spend_, never the funds themselves.

> Status: **v0.1 — all three phases have shipped their first cut.** Advisory SDK-mode + full observability, end to end — fully offline on mock rails, and **live on real x402 rails on Base Sepolia** (EIP-3009 USDC settled by the hosted x402.org facilitator — on both sides: the guarded agent _and_ a `@reinconsole/gate`-monetized vendor). The **session-key signer tier** — the GA enforcement architecture, where the wallet key leaves the agent entirely — ships as `@reinconsole/signer`. The supply side ships as **`@reinconsole/gate`**, vendor monetization middleware (Phase 2). The stack is **durable**: `@reinconsole/store` persists the engine (agents, policies, spend, the signed decision chain), the reputation evidence, gate receipts + replay slots, and signer sessions across restarts. And **`@reinconsole/graph`** (Phase 3) turns the receipts both sides produce into explainable reputation scores that feed back into enforcement: `vendorReputationLt` policies on the agent side, payer screening at the vendor's door. Identity is on-chain: **`@reinconsole/erc8004`** keys reputation by ratified ERC-8004 registrations — **verified live against the real Base Sepolia Identity Registry**.

## Product phases

| Phase | Name      | What it does                                                        |
| ----- | --------- | ------------------------------------------------------------------- |
| 1     | **Guard** | Policy enforcement + observability for agent payments (demand side) |
| 2     | **Gate**  | x402 monetization middleware for API vendors (supply side)          |
| 3     | **Graph** | Reputation scoring over agents and vendors (the data moat)          |

## What's in v0.1

A complete demand-side Guard loop, runnable two ways: fully offline on mock rails (no accounts, no Docker, no chain), or live on Base Sepolia over the real x402 stack:

- **`@reinconsole/sdk`** — wrap your agent's fetch once; every x402 paywall is policy-checked, receipted, and observable _before a cent moves_.
- **`@reinconsole/policy-engine`** — a sandboxed declarative rule engine (`deny > escalate > allow > default`) behind a Fastify API. Every decision is ed25519-signed and sha256 hash-chained into a tamper-evident audit log.
- **`@reinconsole/core`** — the canonical zod schemas: the single source of truth for DB rows, API payloads, and SDK types, with float-free decimal money math.
- **`@reinconsole/mock-rails`** — a simulated payment world (x402 facilitator + on-chain ledger + indexer) that reconciles spend and flags **shadow spend**: payments that bypassed the guard.
- **`@reinconsole/x402-rails`** — the real-world rails: an EIP-3009 payer (gasless for the agent — the facilitator submits the tx), a client for the hosted [x402.org facilitator](https://x402.org), a strict x402-v1 vendor, and an on-chain indexer that reconciles USDC transfers back to intents via the authorization nonce — and flags everything else as shadow spend.
- **`@reinconsole/console`** — a live "mission control" web UI over the whole stack: decisions, vendor-gate quotes/receipts/refusals, signer releases, settlements, and shadow spends streaming in real time; kill switch, vendor revenue panel, the live reputation scoreboard (scores, confidence, and the evidence behind them), and the tamper-evident audit chain.
- **`@reinconsole/signer`** — the custody tier. Wallet keys live in the signer, agents get capped, expiring session tokens, and every EIP-3009 signature is released only against an engine-signed **allow voucher for the exact transfer being signed** — verified offline, usable once. Where SDK mode _detects_ bypass, this tier _prevents_ it.
- **`@reinconsole/gate`** — the supply side (Phase 2). Middleware a vendor drops in front of any Node HTTP API to monetize it over x402: price routes by glob, quote strict v1 402s, cross-check + screen + replay-protect incoming payments, settle through pluggable rails (mock or the real facilitator), and keep vendor-side receipts and revenue stats. **Verified live on Base Sepolia** against the hosted facilitator.
- **`@reinconsole/store`** — persistence. Postgres-backed stores (embedded [PGlite](https://pglite.dev) — no Docker, no daemon, upgradeable to hosted Postgres) behind every service's store ports: agents, the kill switch, policies in evaluation order, rolling spend history, the ed25519 signing key, and the hash-chained decision log all survive restarts — the chain resumes from the last persisted hash and verifies end to end across the seam. The reputation graph's **evidence ledger persists here too** (scores are never stored — they recompute byte-identically from rehydrated evidence), including in-flight intent correlations, so a settlement that lands after a restart is still attributed. So do the **gate's receipts and replay slots** (a pre-kill payment is refused as a replay post-restart) and the **signer's session grants** — spend against caps, revocations, and burned vouchers; wallet private keys deliberately never (KMS territory).
- **`@reinconsole/graph`** — reputation (Phase 3). One graph observes every bus the stack already publishes — engine decisions, indexer settlements, gate receipts and refusals, signer events — and scores every vendor and payer it has evidence on: five explainable 0–100 components plus first-class confidence, recomputed from raw evidence on demand. Scores feed back into enforcement on both sides: `syncVendors(engine.spend)` makes `vendorReputationLt` policies fire, `payerCheck(graph)` plugs into gate screening. `graph.link()` merges identities across id spaces (an agent's engine ULID and its paying wallet, a vendor's host and its payTo address — the ERC-8004 story) so one party carries one history: an agent's engine-side sins follow its wallet to every gate's door.
- **`@reinconsole/erc8004`** — the on-chain identity source. Reads identity facts from the ratified [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) Identity Registry (an ERC-721; singleton deployments, Base Sepolia included) and turns them into link facts for the graph: a registered agent's reputation keys by its on-chain identity (`eip155:{chainId}:{registry}/{tokenId}`) with the local id and every wallet — `ownerOf`, the EIP-712-verified `agentWallet` — folded in as aliases; vendors stay host-keyed. Ships the write path too (**registers agents on the real Base Sepolia registry**) and an in-memory registry twin for offline work.

**435 tests passing** (plus 8 live network tests gated behind `RUN_LIVE=1`). The mock end-to-end demo runs 5 scenarios in under 500ms; the gate demo runs the full two-sided loop over real local HTTP; the graph demo closes the reputation loop on both sides; the Sepolia demos settle real USDC — and the identity demo registers a real agent on the Base Sepolia ERC-8004 registry.

## Install

The eight library packages are published on npm under the [`@reinconsole`](https://www.npmjs.com/org/reinconsole) scope (`0.1.1`, MIT, Node ≥22):

```bash
npm install @reinconsole/sdk     # agent-side guard — wrap your fetch
npm install @reinconsole/gate    # vendor-side x402 monetization middleware
npm install @reinconsole/graph   # explainable reputation scoring
```

| Package | What it's for |
| ------- | ------------- |
| [`@reinconsole/core`](https://www.npmjs.com/package/@reinconsole/core) | Canonical zod schemas — the single source of truth |
| [`@reinconsole/sdk`](https://www.npmjs.com/package/@reinconsole/sdk) | Agent-side guard; wraps the x402 client |
| [`@reinconsole/policy-engine`](https://www.npmjs.com/package/@reinconsole/policy-engine) | Declarative rule engine + signed, hash-chained audit log |
| [`@reinconsole/gate`](https://www.npmjs.com/package/@reinconsole/gate) | Vendor-side x402 monetization middleware |
| [`@reinconsole/graph`](https://www.npmjs.com/package/@reinconsole/graph) | Reputation: evidence off every bus, explainable scores |
| [`@reinconsole/x402-rails`](https://www.npmjs.com/package/@reinconsole/x402-rails) | Real rails: EIP-3009 payer + x402.org facilitator client + indexer |
| [`@reinconsole/mock-rails`](https://www.npmjs.com/package/@reinconsole/mock-rails) | Offline x402 world: facilitator + ledger + indexer |
| [`@reinconsole/erc8004`](https://www.npmjs.com/package/@reinconsole/erc8004) | On-chain identity: ERC-8004 registry reads/writes → link facts |

The custody tier (`@reinconsole/signer`) and persistence layer (`@reinconsole/store`) are intentionally **not** published yet — session-key custody is the GA architecture. Build them from source (below).

## Quickstart

```bash
npm install -g pnpm  # if you don't have pnpm — `corepack enable` works too, but needs an admin shell on Windows
pnpm install
pnpm build           # ~2 min
pnpm test            # 435 tests, fully offline, ~3 min

# Watch the whole thing work — budgets, tx caps, kill switch, shadow-spend detection:
node apps/demo/dist/index.js

# Then watch the custody tier refuse every rogue path a stolen agent could try:
node apps/demo/dist/signer.js

# Then flip to the vendor side: price routes, screen payers, count revenue:
node apps/demo/dist/gate.js

# Then close the loop: reputation scores that change what both sides enforce:
node apps/demo/dist/graph.js
```

## Console — live mission control

A real-time web UI for the **whole stack at once**: the real policy engine (over HTTP), a real `@reinconsole/gate` fronting the world's vendor API, the session-key signer holding a custodied wallet, the reputation graph observing every bus, and the mock rails standing in for the chain. Every bus — engine, indexer, gate, signer — is merged and pushed to the browser over Server-Sent Events.

```bash
pnpm --filter @reinconsole/console dev      # http://localhost:5173
```

What you see:

- **Live activity feed** — decisions (allow / deny / escalate), x402 quotes, vendor receipts, payments turned away at the gate, EIP-3009 signatures released or refused by the signer, settlements, and shadow spends — streaming in as they happen.
- **Vendor gate** — what the world's gated API is earning: revenue headline, per-route and per-payer breakdowns from real gate receipts.
- **Reputation** — the live scoreboard from `@reinconsole/graph`: every vendor and payer the world has evidence on, with confidence, click-to-expand explanations (five components + the raw counts behind them), "→ engine" on vendor scores synced into policy, and "barred" on wallets the gate turns away. The graph re-syncs after every burst of evidence, so watch the world's own vendor cross the confidence floor as scenario runs accumulate.
- **Agents + kill switch** — both custody tiers side by side (`sdk` and `session-key`), per-agent session spend, and a freeze/unfreeze toggle; hit **Ping** on a frozen agent and watch the call get denied.
- **Policies** — the active rules in plain language.
- **Audit chain** — the ed25519-signed, sha256-linked decision log with a live integrity check.
- **Shadow spends** — unreconciled, guard-bypassing payments, flagged in red.

Click **Run scenario** to play the full two-sided story, paced so you can watch it unfold: a fresh SDK-tier agent makes four paid calls (quote → allow → vendor receipt → settle), trips the budget cap and the tx cap, then bypasses the guard (shadow spend); an unpaid crawler gets quoted; a replayed payment and a denylisted mule get turned away at the gate; then a session-key agent — wallet held by the signer — makes voucher-gated EIP-3009 purchases, a stolen voucher is replayed straight at the signer and refused, and the engine *allows* a payment the session cap still refuses: defense in depth, live. The finale closes the reputation loop on both sides: a procurement agent is denied at a sketchy vendor by the `reputation-gate` policy rule, served at a reputable one on the same policy, and a wallet that replayed payments at *other* vendors' gates two weeks ago presents a fresh, valid payment — and is turned away on reputation alone.

The session-key payments in this world are real EIP-3009 signatures, verified cryptographically (signature recovery against the quoted USDC contract domain) before the gate settles them — a forged or tampered authorization genuinely fails. For a production-style serve (built UI + API on one port): `pnpm --filter @reinconsole/console build && pnpm --filter @reinconsole/console start`.

Set `REIN_CONSOLE_DATA_DIR` to run the console world on `@reinconsole/store`: agents, policies, the kill switch, the decision chain, rolling budgets, and the reputation scoreboard all survive a restart (the boot seed runs once per data directory; the feed is telemetry and starts fresh). Kill the server mid-story, start it again, and run the scenario — the new agents pick up numbered names where the old ones left off, the chain extends the pre-restart hashes, and the door still turns away the offender on evidence recorded before the kill.

Run the policy engine standalone:

```bash
# PowerShell
$env:PORT="8787"; node services/policy-engine/dist/server.js
# bash
PORT=8787 node services/policy-engine/dist/server.js
```

## Persistence: an engine that survives restarts

The in-memory engine is great for demos; `@reinconsole/store` makes it durable. It implements the engine's store ports on embedded Postgres ([PGlite](https://pglite.dev) — real Postgres compiled to WASM, running in-process against a data directory; no Docker, no daemon, and the SQL carries straight over to hosted Postgres later). Writes are awaited to disk before the engine acts on them; reads stay synchronous from a hydrated working set.

```bash
# The same HTTP API as the policy engine, but durable:
# PowerShell
$env:REIN_DATA_DIR=".rein-data"; node services/store/dist/server.js
# bash
REIN_DATA_DIR=.rein-data node services/store/dist/server.js
```

Kill it and start it again: agents, the kill switch, policies (in evaluation order), rolling budgets ("$0.60 of the daily $1.00 already spent — _before_ the restart"), and the decision log all come back. The ed25519 signing key is persisted too, so the hash chain **continues** across restarts — the first post-restart decision links to the last pre-restart hash, and `verifyDecisionChain` validates the whole history under one key, no seam.

The reputation graph gets the same treatment — the same store persists its evidence ledger (and the in-flight intent correlation map, so a settlement that lands after a restart is still attributed to the agent and vendor behind it). Scores are never stored: they recompute from the rehydrated evidence, byte-identical under the same clock.

```bash
# The graph HTTP API, durable (use a DIFFERENT data dir than the engine —
# two processes can't share one PGlite directory):
# PowerShell
$env:REIN_GRAPH_DATA_DIR=".rein-graph-data"; node services/store/dist/graph-server.js
# bash
REIN_GRAPH_DATA_DIR=.rein-graph-data node services/store/dist/graph-server.js
```

The gate and the signer ride the same store: vendor receipts, revenue stats, and burned replay slots resume (a payment settled before a kill is refused as a replay after the restart), and session grants — token hashes, per-session spend against the cap, revocations, and the burned-voucher set — survive a signer restart, so an agent holding a token keeps paying while a revoked one stays dead. Wallet **private keys are deliberately never persisted** (custody keys at rest belong in a KMS/HSM); deployments re-register wallets at boot.

Composing it in code is one line per side — in a single process, one store backs all four:

```ts
import { PolicyEngine } from '@reinconsole/policy-engine';
import { ReputationGraph } from '@reinconsole/graph';
import { createGate } from '@reinconsole/gate';
import { SessionSigner } from '@reinconsole/signer';
import { openReinStore } from '@reinconsole/store';

const store = await openReinStore({ dir: '.rein-data' });
const engine = new PolicyEngine(store);
const graph = new ReputationGraph({ ledger: store.ledger, intents: store.intents });
const gate = createGate({ /* routes, rails, ... */ store: store.gate });
const signer = new SessionSigner({ enginePublicKeyPem: engine.publicKeyPem, store: store.sessions });
```

## Real rails: Base Sepolia

The same guard loop on a real chain — a guarded $0.01 USDC payment settled on-chain by the hosted x402.org facilitator, then a rogue payment that bypasses the guard and gets caught:

```bash
pnpm --filter @reinconsole/demo demo:sepolia
```

The first run generates an agent wallet into `.env` and prints faucet instructions — fund it with free testnet USDC at [faucet.circle.com](https://faucet.circle.com) (no ETH needed; the facilitator pays gas), then run again. A full run spends $0.02 of testnet USDC and ends with two BaseScan links:

- **`payment.settled`** — the guarded payment. The payer derives the EIP-3009 authorization nonce as `keccak256(intent.id)`, USDC emits it back in `AuthorizationUsed` on settlement, and the on-chain indexer reconciles the transfer to the exact intent the policy engine allowed — an on-chain memo, with no fuzzy matching.
- **`shadow.spend`** — the rogue payment. The facilitator is _not_ Rein-privileged, so it settles anyway — and the indexer flags the unreconciled spend.

From a real run: [the settled payment](https://sepolia.basescan.org/tx/0x73c2971ac85330d1b6d21889ffb356716babb4ba740468a8f9066be6ca310689) · [the shadow spend](https://sepolia.basescan.org/tx/0x1352fae21246fefc4bc65f704a2075f121369d4d7f6fc16653f1f68c065b97f1)

And the **vendor side on the same real rails** — a `@reinconsole/gate`-priced Node API settling real USDC through the hosted facilitator while the paying agent stays under guard. One $0.01 payment, quoted, signed (EIP-3009), settled on-chain, receipted on both sides, reconciled by the on-chain indexer via the nonce memo — then the same payment replayed and burned at the door before the facilitator ever sees it:

```bash
pnpm --filter @reinconsole/demo demo:sepolia-gate   # reuses the demo:sepolia wallet
```

From a real run: [the gate-settled payment](https://sepolia.basescan.org/tx/0x30eb018d1e6cacdb4e7479e0370a2ec43136c414808a2124712f0c46c975ab8e)

The live test suite (`RUN_LIVE=1 pnpm --filter @reinconsole/x402-rails test`) exercises the same path. Behind a TLS-intercepting proxy or antivirus, point Node at your local root CA first (`NODE_EXTRA_CA_CERTS`) — see `env.example`.

## The signer tier: keys the agent never holds

SDK mode is honest about its limit: an agent that holds its own key can bypass the guard, and Rein _catches_ it (shadow spend). `@reinconsole/signer` removes the limit by removing the key. The agent process gets a **session token** — capped, expiring, revocable — and the wallet lives in the signer, which releases an EIP-3009 signature only when every gate passes:

1. **A valid voucher.** The engine binds each decision to the exact intent it judged (`intentHash` over amount, recipient, asset, chain), ed25519-signs it, and chains it into the audit log. The signer verifies the pair fully offline — a rogue agent can recompute every hash, but it cannot sign as the engine.
2. **An exact match.** The 402 requirement being signed must equal what the engine judged: recipient, amount, asset, network. A real $0.01 voucher cannot authorize a $5.00 transfer.
3. **Once.** One decision releases one signature; replays are refused — including two concurrent requests racing the same voucher.
4. **Within the session.** Per-payment and cumulative caps, expiry, and revocation are enforced at the signing boundary, _under_ whatever policy says.

Every release and refusal is emitted on the event bus (`signature.released` / `signature.refused`). The kill switch stops being advisory: freeze the agent and there is no allow, no signature, no payment.

```bash
pnpm --filter @reinconsole/demo demo:signer   # six scenarios, fully offline, every signature verified
```

Run it as a service (`buildSignerServer`) with the SDK's `createRemoteSessionPayer`, or in-process with `sessionPayerFor`. There is deliberately no HTTP endpoint that accepts a private key.

## Gate: the vendor side of the wire

Everything above governs the agent _spending_. `@reinconsole/gate` is Phase 2 — the same loop from the vendor's seat. Price your routes once, and every x402 payment into your API is quoted, cross-checked, screened, settled, and receipted before your handler runs:

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

What the gate does that a bare 402 snippet doesn't:

- **Quote consistency.** A presented payment must match the gate's own quote — scheme, network, amount, recipient — before any facilitator round-trip. Underpayment is refused at the door.
- **Payer screening.** Allow/deny lists on the paying wallet — plus a dynamic `screen.check` hook (reputation plugs in here) — checked _before_ verify/settle, so a blocked payer costs you nothing.
- **Replay protection.** Each payment settles once; the slot is burned before the async legs, so two concurrent copies can't both pass (on-chain nonce burning is a luxury the mock chain doesn't have — the gate doesn't care).
- **Receipts + revenue.** Every settlement becomes a `GateReceipt` (`grc_` ULID); `gate.stats()` aggregates revenue by asset, route, and payer; `gate.quoted` / `gate.settled` / `gate.refused` events stream on the bus.
- **Pluggable rails.** The same gate runs against the mock facilitator (offline tests/demos) or the real hosted x402.org facilitator client — the rails are a two-method structural seam.

```bash
pnpm --filter @reinconsole/demo demo:gate          # six scenarios, offline: guarded agent pays a gated vendor over real local HTTP
pnpm --filter @reinconsole/demo demo:sepolia-gate  # the same gate on REAL rails: settles testnet USDC via the hosted facilitator
```

## Graph: reputation closes the loop

Guard receipts say what agents tried to spend; gate receipts say what vendors actually earned. `@reinconsole/graph` (Phase 3) is the consumer of both — and the feedback path that turns observability into enforcement:

```ts
import { ReputationGraph, payerCheck } from '@reinconsole/graph';

const graph = new ReputationGraph().observe(engine).observe(indexer).observe(gate);

// Agent side: pushed scores make `vendorReputationLt` policies fire.
await graph.syncVendors(engine.spend);

// Vendor side: low-reputation wallets are turned away at the door.
createGate({ screen: { check: payerCheck(graph, { denyBelow: 40 }) }, ... });
```

- **Evidence, not vibes.** The graph accumulates per-subject history straight off the event buses: settlements, refusals (replays weighted heaviest), shadow spends, settled-money edges between counterparties, and manual dispute/endorsement reports. Scores are recomputed from raw evidence on demand — `GET /v1/scores/vendor/api.example.com` returns the score _and_ everything behind it.
- **Five components + confidence.** Settlement reliability, dispute hygiene, volume, longevity, and one-hop counterparty quality (who you settle with marks you), blended 0–100. Confidence is first-class: a thin or brand-new history yields low confidence, not a fake number.
- **Unknown is not bad.** The evaluator never fires `vendorReputationLt` without data, the sync withholds low-confidence scores, and `payerCheck` passes wallets it knows nothing about. A newcomer is served; a _confidently_ bad actor is refused.
- **The network effect.** Evidence from one vendor's gate protects every other gate sharing the graph — a mule that replayed payments elsewhere is refused here, before any facilitator round-trip.
- **One identity, one history.** `graph.link(canonical, alias)` merges subjects across id spaces — evidence recorded under either id folds together (counters sum, settled-money edges re-key on both ends), all future evidence and lookups resolve to the canonical identity, and merges persist on the durable store. Links are derived facts (your agent registry knows its wallets; ERC-8004 ids are the on-chain source): re-assert them at boot, idempotently. The console world does exactly this — one scoreboard row per party, and `payerCheck` refuses a wallet for what its *agent* did on the engine side.

```bash
pnpm --filter @reinconsole/demo demo:graph   # five scenarios, offline: both feedback loops close live
```

### ERC-8004: identity from the chain

`@reinconsole/erc8004` makes the registry the *source* of link facts instead of local configuration. A registered agent becomes **ERC-8004-canonical**: its reputation row keys by `eip155:{chainId}:{registry}/{tokenId}`, and the engine ULID plus every wallet (`ownerOf`, the verified `agentWallet`) fold in as aliases — so two deployments claiming the same registration merge into one history, and key rotation never splits a score. Vendors stay host-canonical (hosts are what intents carry and `vendorReputationLt` matches); their identities and treasuries fold into the host row. Unregistered agents keep today's local linking — the fallback is byte-compatible.

```bash
pnpm --filter @reinconsole/demo demo:erc8004        # five scenarios, offline: one on-chain identity, one reputation
pnpm --filter @reinconsole/demo demo:sepolia-8004   # REAL registration on the Base Sepolia registry (one-time gas; re-runs read-only)
```

Run it as a service (`buildGraphServer`): remote producers `POST /v1/events`, anyone reads `GET /v1/scores` — or run the **durable variant** (`services/store/dist/graph-server.js`), where the evidence survives restarts (see Persistence). Or watch it live: the console world runs a graph over all four buses, re-syncs it into the engine after every burst of evidence, and renders the scoreboard with click-to-expand explanations.

## The SDK one-liner

Wrap your agent's fetch, point it at a policy engine, and every x402 payment is governed:

```ts
import { createGuard } from '@reinconsole/sdk';

const guard = createGuard({
  engineUrl: 'http://localhost:8787',
  agentId: 'agt_01J...', // registered with the engine
  onReceipt: (r) => console.log(r.outcome, r.amount, r.vendorHost),
});

const fetch = guard.wrap(); // a drop-in fetch

// A 402 from the vendor is intercepted, the intent is evaluated, and a
// blocked payment never reaches the network. Allowed payments flow through
// and the settlement is captured back onto the receipt.
const res = await fetch('https://api.vendor.example/v1/search?q=...');
```

The guard layers _underneath_ any x402 payment library: the first unpaid request surfaces the 402, the guard evaluates it and either blocks it (so the payment layer never sees the paywall) or releases it upward — and the `X-PAYMENT` retry flows back through to attach the settlement. Or pass a `payer` and the guard settles directly.

## The policy engine API

`POST /v1/evaluate` is the hot path (sub-millisecond, signed + chained). Also: register agents, manage policies, flip the kill switch, and read the audit log.

| Method | Route                        | Purpose                                       |
| ------ | ---------------------------- | --------------------------------------------- |
| GET    | `/health`                    | Liveness + the engine's signing public key    |
| POST   | `/v1/agents`                 | Register an agent (returns a `agt_` ULID)     |
| GET    | `/v1/agents`                 | List agents                                   |
| POST   | `/v1/agents/:id/freeze`      | Kill switch on (deny everything)              |
| POST   | `/v1/agents/:id/unfreeze`    | Kill switch off                               |
| POST   | `/v1/policies`               | Add a policy                                  |
| GET    | `/v1/policies`               | List policies                                 |
| POST   | `/v1/evaluate`               | Evaluate a payment intent → signed decision   |
| GET    | `/v1/decisions`              | The hash-chained decision log                 |

A policy is declarative — for example, a $0.50 per-transaction cap plus a rolling $0.04/hour budget, defaulting to allow:

```json
{
  "policyId": "research-policy",
  "appliesTo": { "agents": ["agt_01J..."] },
  "rules": [
    { "id": "tx-cap", "deny": { "amountGt": "0.50" } },
    { "id": "hour-budget", "deny": { "rollingSum": { "window": "1h", "gt": "0.04" } } }
  ],
  "default": "allow"
}
```

## Design principles

1. **Non-custodial.** Rein governs authority to spend, not the funds.
2. **Fail closed.** If the policy service is unreachable, payments above a configured floor are denied, not allowed. Ungovernable x402 offers fail closed too.
3. **Rail-agnostic core, x402-first integration.** The policy/ledger domain model knows nothing about x402 specifically; x402 (Base, Solana) is the first adapter.
4. **Every decision is auditable.** Each allow/deny produces a signed, hash-chained decision record linked to the eventual on-chain transaction.
5. **Honest about its tier.** The facilitator — mock or the real hosted one — is _not_ Rein-privileged: in SDK mode a rogue payment still settles, and the indexer flags it as shadow spend (verified live on Base Sepolia). The session-key signer tier closes that gap: the key the rogue would need no longer exists in the agent.

## Repository layout

```
packages/
  core/          @reinconsole/core           — canonical zod schemas (single source of truth)                            [published]
  sdk/           @reinconsole/sdk            — agent-side guard; wraps the x402 client                                   [published]
  gate/          @reinconsole/gate           — vendor-side x402 monetization middleware                                  [published]
services/
  policy-engine/ @reinconsole/policy-engine  — Fastify policy evaluation service + audit log                             [published]
  mock-rails/    @reinconsole/mock-rails     — mock x402 facilitator + ledger + indexer                                  [published]
  x402-rails/    @reinconsole/x402-rails     — real rails: EIP-3009 payer, x402.org facilitator client, on-chain indexer  [published]
  graph/         @reinconsole/graph          — reputation: evidence off every bus, explainable scores, policy+gate feed  [published]
  erc8004/       @reinconsole/erc8004        — on-chain identity: ERC-8004 registry reads/writes → link facts            [published]
  signer/        @reinconsole/signer         — session-key custody: voucher-gated EIP-3009 signing, caps, kill switch    [private]
  store/         @reinconsole/store          — persistence: PGlite-backed engine + graph stores; state survives restarts [private]
apps/
  demo/          @reinconsole/demo           — end-to-end demos: mock (5 scenarios) + real Base Sepolia (guard + gate) + signer tier + gate + graph
  console/       @reinconsole/console        — live web UI: real-time feed, kill switch, audit chain, shadow-spend alerts
```

## Tech

- **Language:** TypeScript end-to-end (Node 22 LTS), strict mode.
- **Monorepo:** pnpm workspaces + Turborepo.
- **Schemas:** zod, in `@reinconsole/core`, as the single source of truth for DB rows, API payloads, and SDK types.
- **Build/test:** tsup (esm + cjs + d.ts), vitest.
- **Console:** Vite + React + TypeScript, live updates over Server-Sent Events (no extra services to run).
- **Chain:** viem on Base Sepolia — EIP-712/EIP-3009 signing, `getLogs` indexing, the hosted x402.org facilitator for settlement.
- **Dev mode:** mock x402 flows + in-memory stores behind ports, with `@reinconsole/store` (embedded PGlite Postgres) when you want state to survive restarts. No accounts or Docker required to run locally; hosted Postgres + Timescale + Redis + NATS wire in later behind the same ports.

## License

MIT
