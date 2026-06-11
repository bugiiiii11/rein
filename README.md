# Rein

**The control plane for AI agent payments.** Rein sets the rules, watches every payment, and scores every counterparty — so agents can transact at machine speed without machine-speed losses.

Rein is developer tooling and middleware for the agentic payments economy (the [x402](https://www.x402.org) / ERC-8004 stack). It is **non-custodial**: Rein governs an agent's _authority to spend_, never the funds themselves.

> Status: **v0.1 — Guard, and the first cut of Gate.** Advisory SDK-mode + full observability, end to end — fully offline on mock rails, and **live on real x402 rails on Base Sepolia** (EIP-3009 USDC settled by the hosted x402.org facilitator — on both sides: the guarded agent _and_ a `@rein/gate`-monetized vendor). The **session-key signer tier** — the GA enforcement architecture, where the wallet key leaves the agent entirely — ships as `@rein/signer`. The supply side ships as **`@rein/gate`**, vendor monetization middleware (Phase 2). And the engine is now **durable**: `@rein/store` persists agents, policies, spend history, and the signed decision chain across restarts.

## Product phases

| Phase | Name      | What it does                                                        |
| ----- | --------- | ------------------------------------------------------------------- |
| 1     | **Guard** | Policy enforcement + observability for agent payments (demand side) |
| 2     | **Gate**  | x402 monetization middleware for API vendors (supply side)          |
| 3     | **Graph** | Reputation scoring over agents and vendors (the data moat)          |

## What's in v0.1

A complete demand-side Guard loop, runnable two ways: fully offline on mock rails (no accounts, no Docker, no chain), or live on Base Sepolia over the real x402 stack:

- **`@rein/sdk`** — wrap your agent's fetch once; every x402 paywall is policy-checked, receipted, and observable _before a cent moves_.
- **`@rein/policy-engine`** — a sandboxed declarative rule engine (`deny > escalate > allow > default`) behind a Fastify API. Every decision is ed25519-signed and sha256 hash-chained into a tamper-evident audit log.
- **`@rein/core`** — the canonical zod schemas: the single source of truth for DB rows, API payloads, and SDK types, with float-free decimal money math.
- **`@rein/mock-rails`** — a simulated payment world (x402 facilitator + on-chain ledger + indexer) that reconciles spend and flags **shadow spend**: payments that bypassed the guard.
- **`@rein/x402-rails`** — the real-world rails: an EIP-3009 payer (gasless for the agent — the facilitator submits the tx), a client for the hosted [x402.org facilitator](https://x402.org), a strict x402-v1 vendor, and an on-chain indexer that reconciles USDC transfers back to intents via the authorization nonce — and flags everything else as shadow spend.
- **`@rein/console`** — a live "mission control" web UI over the whole stack: decisions, vendor-gate quotes/receipts/refusals, signer releases, settlements, and shadow spends streaming in real time; kill switch, vendor revenue panel, and the tamper-evident audit chain.
- **`@rein/signer`** — the custody tier. Wallet keys live in the signer, agents get capped, expiring session tokens, and every EIP-3009 signature is released only against an engine-signed **allow voucher for the exact transfer being signed** — verified offline, usable once. Where SDK mode _detects_ bypass, this tier _prevents_ it.
- **`@rein/gate`** — the supply side (Phase 2). Middleware a vendor drops in front of any Node HTTP API to monetize it over x402: price routes by glob, quote strict v1 402s, cross-check + screen + replay-protect incoming payments, settle through pluggable rails (mock or the real facilitator), and keep vendor-side receipts and revenue stats. **Verified live on Base Sepolia** against the hosted facilitator.
- **`@rein/store`** — persistence. Postgres-backed engine stores (embedded [PGlite](https://pglite.dev) — no Docker, no daemon, upgradeable to hosted Postgres) behind the engine's store ports: agents, the kill switch, policies in evaluation order, rolling spend history, the ed25519 signing key, and the hash-chained decision log all survive restarts — the chain resumes from the last persisted hash and verifies end to end across the seam.

**202 tests passing** (plus 2 live network tests gated behind `RUN_LIVE=1`). The mock end-to-end demo runs 5 scenarios in under 500ms; the gate demo runs the full two-sided loop over real local HTTP; the Sepolia demos settle real USDC.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test            # 202 tests, fully offline

# Watch the whole thing work — budgets, tx caps, kill switch, shadow-spend detection:
node apps/demo/dist/index.js

# Then watch the custody tier refuse every rogue path a stolen agent could try:
node apps/demo/dist/signer.js

# Then flip to the vendor side: price routes, screen payers, count revenue:
node apps/demo/dist/gate.js
```

## Console — live mission control

A real-time web UI for the **whole stack at once**: the real policy engine (over HTTP), a real `@rein/gate` fronting the world's vendor API, the session-key signer holding a custodied wallet, and the mock rails standing in for the chain. Every bus — engine, indexer, gate, signer — is merged and pushed to the browser over Server-Sent Events.

```bash
pnpm --filter @rein/console dev      # http://localhost:5173
```

What you see:

- **Live activity feed** — decisions (allow / deny / escalate), x402 quotes, vendor receipts, payments turned away at the gate, EIP-3009 signatures released or refused by the signer, settlements, and shadow spends — streaming in as they happen.
- **Vendor gate** — what the world's gated API is earning: revenue headline, per-route and per-payer breakdowns from real gate receipts.
- **Agents + kill switch** — both custody tiers side by side (`sdk` and `session-key`), per-agent session spend, and a freeze/unfreeze toggle; hit **Ping** on a frozen agent and watch the call get denied.
- **Policies** — the active rules in plain language.
- **Audit chain** — the ed25519-signed, sha256-linked decision log with a live integrity check.
- **Shadow spends** — unreconciled, guard-bypassing payments, flagged in red.

Click **Run scenario** to play the full two-sided story, paced so you can watch it unfold: a fresh SDK-tier agent makes four paid calls (quote → allow → vendor receipt → settle), trips the budget cap and the tx cap, then bypasses the guard (shadow spend); an unpaid crawler gets quoted; a replayed payment and a denylisted mule get turned away at the gate; then a session-key agent — wallet held by the signer — makes voucher-gated EIP-3009 purchases, a stolen voucher is replayed straight at the signer and refused, and finally the engine *allows* a payment the session cap still refuses: defense in depth, live.

The session-key payments in this world are real EIP-3009 signatures, verified cryptographically (signature recovery against the quoted USDC contract domain) before the gate settles them — a forged or tampered authorization genuinely fails. For a production-style serve (built UI + API on one port): `pnpm --filter @rein/console build && pnpm --filter @rein/console start`.

Run the policy engine standalone:

```bash
# PowerShell
$env:PORT="8787"; node services/policy-engine/dist/server.js
# bash
PORT=8787 node services/policy-engine/dist/server.js
```

## Persistence: an engine that survives restarts

The in-memory engine is great for demos; `@rein/store` makes it durable. It implements the engine's store ports on embedded Postgres ([PGlite](https://pglite.dev) — real Postgres compiled to WASM, running in-process against a data directory; no Docker, no daemon, and the SQL carries straight over to hosted Postgres later). Writes are awaited to disk before the engine acts on them; reads stay synchronous from a hydrated working set.

```bash
# The same HTTP API as the policy engine, but durable:
# PowerShell
$env:REIN_DATA_DIR=".rein-data"; node services/store/dist/server.js
# bash
REIN_DATA_DIR=.rein-data node services/store/dist/server.js
```

Kill it and start it again: agents, the kill switch, policies (in evaluation order), rolling budgets ("$0.60 of the daily $1.00 already spent — _before_ the restart"), and the decision log all come back. The ed25519 signing key is persisted too, so the hash chain **continues** across restarts — the first post-restart decision links to the last pre-restart hash, and `verifyDecisionChain` validates the whole history under one key, no seam.

Composing it in code is one line:

```ts
import { PolicyEngine } from '@rein/policy-engine';
import { openReinStore } from '@rein/store';

const engine = new PolicyEngine(await openReinStore({ dir: '.rein-data' }));
```

## Real rails: Base Sepolia

The same guard loop on a real chain — a guarded $0.01 USDC payment settled on-chain by the hosted x402.org facilitator, then a rogue payment that bypasses the guard and gets caught:

```bash
pnpm --filter @rein/demo demo:sepolia
```

The first run generates an agent wallet into `.env` and prints faucet instructions — fund it with free testnet USDC at [faucet.circle.com](https://faucet.circle.com) (no ETH needed; the facilitator pays gas), then run again. A full run spends $0.02 of testnet USDC and ends with two BaseScan links:

- **`payment.settled`** — the guarded payment. The payer derives the EIP-3009 authorization nonce as `keccak256(intent.id)`, USDC emits it back in `AuthorizationUsed` on settlement, and the on-chain indexer reconciles the transfer to the exact intent the policy engine allowed — an on-chain memo, with no fuzzy matching.
- **`shadow.spend`** — the rogue payment. The facilitator is _not_ Rein-privileged, so it settles anyway — and the indexer flags the unreconciled spend.

From a real run: [the settled payment](https://sepolia.basescan.org/tx/0x73c2971ac85330d1b6d21889ffb356716babb4ba740468a8f9066be6ca310689) · [the shadow spend](https://sepolia.basescan.org/tx/0x1352fae21246fefc4bc65f704a2075f121369d4d7f6fc16653f1f68c065b97f1)

And the **vendor side on the same real rails** — a `@rein/gate`-priced Node API settling real USDC through the hosted facilitator while the paying agent stays under guard. One $0.01 payment, quoted, signed (EIP-3009), settled on-chain, receipted on both sides, reconciled by the on-chain indexer via the nonce memo — then the same payment replayed and burned at the door before the facilitator ever sees it:

```bash
pnpm --filter @rein/demo demo:sepolia-gate   # reuses the demo:sepolia wallet
```

From a real run: [the gate-settled payment](https://sepolia.basescan.org/tx/0x30eb018d1e6cacdb4e7479e0370a2ec43136c414808a2124712f0c46c975ab8e)

The live test suite (`RUN_LIVE=1 pnpm --filter @rein/x402-rails test`) exercises the same path. Behind a TLS-intercepting proxy or antivirus, point Node at your local root CA first (`NODE_EXTRA_CA_CERTS`) — see `env.example`.

## The signer tier: keys the agent never holds

SDK mode is honest about its limit: an agent that holds its own key can bypass the guard, and Rein _catches_ it (shadow spend). `@rein/signer` removes the limit by removing the key. The agent process gets a **session token** — capped, expiring, revocable — and the wallet lives in the signer, which releases an EIP-3009 signature only when every gate passes:

1. **A valid voucher.** The engine binds each decision to the exact intent it judged (`intentHash` over amount, recipient, asset, chain), ed25519-signs it, and chains it into the audit log. The signer verifies the pair fully offline — a rogue agent can recompute every hash, but it cannot sign as the engine.
2. **An exact match.** The 402 requirement being signed must equal what the engine judged: recipient, amount, asset, network. A real $0.01 voucher cannot authorize a $5.00 transfer.
3. **Once.** One decision releases one signature; replays are refused — including two concurrent requests racing the same voucher.
4. **Within the session.** Per-payment and cumulative caps, expiry, and revocation are enforced at the signing boundary, _under_ whatever policy says.

Every release and refusal is emitted on the event bus (`signature.released` / `signature.refused`). The kill switch stops being advisory: freeze the agent and there is no allow, no signature, no payment.

```bash
pnpm --filter @rein/demo demo:signer   # six scenarios, fully offline, every signature verified
```

Run it as a service (`buildSignerServer`) with the SDK's `createRemoteSessionPayer`, or in-process with `sessionPayerFor`. There is deliberately no HTTP endpoint that accepts a private key.

## Gate: the vendor side of the wire

Everything above governs the agent _spending_. `@rein/gate` is Phase 2 — the same loop from the vendor's seat. Price your routes once, and every x402 payment into your API is quoted, cross-checked, screened, settled, and receipted before your handler runs:

```ts
import { createGate, gateMiddleware, facilitatorClientRails } from '@rein/gate';

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
- **Payer screening.** Allow/deny lists on the paying wallet, checked _before_ verify/settle, so a blocked payer costs you nothing.
- **Replay protection.** Each payment settles once; the slot is burned before the async legs, so two concurrent copies can't both pass (on-chain nonce burning is a luxury the mock chain doesn't have — the gate doesn't care).
- **Receipts + revenue.** Every settlement becomes a `GateReceipt` (`grc_` ULID); `gate.stats()` aggregates revenue by asset, route, and payer; `gate.quoted` / `gate.settled` / `gate.refused` events stream on the bus.
- **Pluggable rails.** The same gate runs against the mock facilitator (offline tests/demos) or the real hosted x402.org facilitator client — the rails are a two-method structural seam.

```bash
pnpm --filter @rein/demo demo:gate          # six scenarios, offline: guarded agent pays a gated vendor over real local HTTP
pnpm --filter @rein/demo demo:sepolia-gate  # the same gate on REAL rails: settles testnet USDC via the hosted facilitator
```

## The SDK one-liner

Wrap your agent's fetch, point it at a policy engine, and every x402 payment is governed:

```ts
import { createGuard } from '@rein/sdk';

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
  core/          @rein/core           — canonical zod schemas (single source of truth)   [published]
  sdk/           @rein/sdk            — agent-side guard; wraps the x402 client          [published]
  gate/          @rein/gate           — vendor-side x402 monetization middleware         [published]
services/
  policy-engine/ @rein/policy-engine  — Fastify policy evaluation service + audit log
  mock-rails/    @rein/mock-rails     — mock x402 facilitator + ledger + indexer
  x402-rails/    @rein/x402-rails     — real rails: EIP-3009 payer, x402.org facilitator client, on-chain indexer
  signer/        @rein/signer         — session-key custody: voucher-gated EIP-3009 signing, session caps, kill switch with teeth
  store/         @rein/store          — persistence: PGlite-backed engine stores; key, chain, agents, policies, spend survive restarts
apps/
  demo/          @rein/demo           — end-to-end demos: mock (5 scenarios) + real Base Sepolia (guard + gate) + signer tier + gate
  console/       @rein/console        — live web UI: real-time feed, kill switch, audit chain, shadow-spend alerts
```

## Tech

- **Language:** TypeScript end-to-end (Node 22 LTS), strict mode.
- **Monorepo:** pnpm workspaces + Turborepo.
- **Schemas:** zod, in `@rein/core`, as the single source of truth for DB rows, API payloads, and SDK types.
- **Build/test:** tsup (esm + cjs + d.ts), vitest.
- **Console:** Vite + React + TypeScript, live updates over Server-Sent Events (no extra services to run).
- **Chain:** viem on Base Sepolia — EIP-712/EIP-3009 signing, `getLogs` indexing, the hosted x402.org facilitator for settlement.
- **Dev mode:** mock x402 flows + in-memory stores behind ports, with `@rein/store` (embedded PGlite Postgres) when you want state to survive restarts. No accounts or Docker required to run locally; hosted Postgres + Timescale + Redis + NATS wire in later behind the same ports.

## License

MIT
