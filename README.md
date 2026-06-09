# Rein

**The control plane for AI agent payments.** Rein sets the rules, watches every payment, and scores every counterparty — so agents can transact at machine speed without machine-speed losses.

Rein is developer tooling and middleware for the agentic payments economy (the [x402](https://www.x402.org) / ERC-8004 stack). It is **non-custodial**: Rein governs an agent's _authority to spend_, never the funds themselves.

> Status: **pre-v0.1, in active development.** SDK-mode (advisory + observability) first; signer-level enforcement is the GA architecture.

## Product phases

| Phase | Name      | What it does                                                      |
| ----- | --------- | ----------------------------------------------------------------- |
| 1     | **Guard** | Policy enforcement + observability for agent payments (demand side) |
| 2     | **Gate**  | x402 monetization middleware for API vendors (supply side)        |
| 3     | **Graph** | Reputation scoring over agents and vendors (the data moat)        |

## Design principles

1. **Non-custodial.** Rein governs authority to spend, not the funds.
2. **Fail closed.** If the policy service is unreachable, payments above a configured floor are denied, not allowed.
3. **Rail-agnostic core, x402-first integration.** The policy/ledger domain model knows nothing about x402 specifically; x402 (Base, Solana) is the first adapter.
4. **Every decision is auditable.** Each allow/deny produces a signed, hash-chained decision record linked to the eventual on-chain transaction.

## Repository layout

```
packages/
  core/        @rein/core   — canonical zod schemas (single source of truth)
  sdk/         @rein/sdk     — agent-side SDK; wraps the x402 client            (planned)
services/
  policy-engine/             — Fastify policy evaluation service                (planned)
  indexer/                   — on-chain settlement confirmation + reconciliation (planned)
  api/                       — public REST + internal tRPC                       (planned)
apps/
  dashboard/                 — Next.js observability + policy editor             (planned)
```

## Tech

- **Language:** TypeScript end-to-end (Node 22 LTS).
- **Monorepo:** pnpm workspaces + Turborepo.
- **Schemas:** zod, in `@rein/core`, as the single source of truth for DB rows, API payloads, and SDK types.
- **Dev mode:** mock x402 flows + lightweight in-memory/SQLite stores behind interfaces. No accounts or Docker required to run locally; Base Sepolia + real facilitators wire in later.

## Getting started

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
