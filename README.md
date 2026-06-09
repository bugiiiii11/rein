# Rein

**The control plane for AI agent payments.** Rein sets the rules, watches every payment, and scores every counterparty — so agents can transact at machine speed without machine-speed losses.

Rein is developer tooling and middleware for the agentic payments economy (the [x402](https://www.x402.org) / ERC-8004 stack). It is **non-custodial**: Rein governs an agent's _authority to spend_, never the funds themselves.

> Status: **v0.1 — Guard, SDK-mode.** Advisory enforcement + full observability over mock x402 rails, end to end. Signer-level (session-key) enforcement is the GA architecture.

## Product phases

| Phase | Name      | What it does                                                        |
| ----- | --------- | ------------------------------------------------------------------- |
| 1     | **Guard** | Policy enforcement + observability for agent payments (demand side) |
| 2     | **Gate**  | x402 monetization middleware for API vendors (supply side)          |
| 3     | **Graph** | Reputation scoring over agents and vendors (the data moat)          |

## What's in v0.1

A complete demand-side Guard loop runs locally with no accounts, no Docker, no real chain:

- **`@rein/sdk`** — wrap your agent's fetch once; every x402 paywall is policy-checked, receipted, and observable _before a cent moves_.
- **`@rein/policy-engine`** — a sandboxed declarative rule engine (`deny > escalate > allow > default`) behind a Fastify API. Every decision is ed25519-signed and sha256 hash-chained into a tamper-evident audit log.
- **`@rein/core`** — the canonical zod schemas: the single source of truth for DB rows, API payloads, and SDK types, with float-free decimal money math.
- **`@rein/mock-rails`** — a simulated payment world (x402 facilitator + on-chain ledger + indexer) that reconciles spend and flags **shadow spend**: payments that bypassed the guard.

**92 tests passing.** A 5-scenario end-to-end demo runs in under 500ms.

## Quickstart

```bash
pnpm install
pnpm build
pnpm test            # 92 tests

# Watch the whole thing work — budgets, tx caps, kill switch, shadow-spend detection:
node apps/demo/dist/index.js
```

Run the policy engine standalone:

```bash
# PowerShell
$env:PORT="8787"; node services/policy-engine/dist/server.js
# bash
PORT=8787 node services/policy-engine/dist/server.js
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
5. **Honest about its tier.** The mock facilitator is _not_ Rein-privileged — a rogue payment still settles, and the indexer flags it as shadow spend. That gap is exactly what the GA signer tier closes.

## Repository layout

```
packages/
  core/          @rein/core           — canonical zod schemas (single source of truth)   [published]
  sdk/           @rein/sdk            — agent-side guard; wraps the x402 client          [published]
services/
  policy-engine/ @rein/policy-engine  — Fastify policy evaluation service + audit log
  mock-rails/    @rein/mock-rails     — mock x402 facilitator + ledger + indexer
apps/
  demo/          @rein/demo           — end-to-end v0.1 demo (5 scenarios)
```

## Tech

- **Language:** TypeScript end-to-end (Node 22 LTS), strict mode.
- **Monorepo:** pnpm workspaces + Turborepo.
- **Schemas:** zod, in `@rein/core`, as the single source of truth for DB rows, API payloads, and SDK types.
- **Build/test:** tsup (esm + cjs + d.ts), vitest.
- **Dev mode:** mock x402 flows + in-memory stores behind interfaces. No accounts or Docker required to run locally; Postgres + Timescale + Redis + NATS and real facilitators wire in later.

## License

MIT
