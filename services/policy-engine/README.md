# @reinconsole/policy-engine

The rule engine of **[Rein](https://github.com/bugiiiii11/rein)** — the control plane for AI agent payments. A sandboxed, declarative policy engine that judges every payment intent (`deny > escalate > allow > default`), with every decision ed25519-signed and sha256 hash-chained into a tamper-evident audit log.

> **Status: v0.1 — early open-source infrastructure, live on testnet.** APIs may change before 1.0. See it running: [Rein console](https://reinconsole-production.up.railway.app/).

## Install & run

```bash
npm install @reinconsole/policy-engine
# or just run it:
npx -p @reinconsole/policy-engine rein-policy-engine   # HTTP API on :8787 (PORT/HOST env)
```

Point [`@reinconsole/sdk`](https://www.npmjs.com/package/@reinconsole/sdk)'s guard at it (`engineUrl`) and every x402 paywall your agent hits is evaluated here first.

## In-process

```ts
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';

const engine = new PolicyEngine();      // in-memory stores by default
const app = buildServer(engine);        // Fastify instance (not yet listening)
await app.listen({ port: 8787 });
```

## What it does

- **Declarative policies** — budgets over rolling windows, per-tx caps, vendor allow/deny lists by glob, escalation, and reputation rules (`vendorReputationLt`, fed by [`@reinconsole/graph`](https://www.npmjs.com/package/@reinconsole/graph)). Precedence is `deny > escalate > allow > default`.
- **Kill switch** — freeze an agent and there is no allow; the check happens before evaluation.
- **Signed decisions** — each decision commits to the exact intent it judged (`intentHash`), is ed25519-signed, and links to the previous decision's hash. `verifyDecisionChain` validates the whole history offline; the `{intent, decision}` pair is a self-contained spend voucher downstream tiers verify without calling back.
- **Store ports** — agents, policies, rolling spend, and the decision log sit behind injectable ports (`SpendStorePort`, `PolicyStorePort`, `AgentRegistryPort`). In-memory implementations ship here; the durable Postgres-backed variant lives in the [monorepo](https://github.com/bugiiiii11/rein) (`@reinconsole/store`) and keeps the hash chain continuous across restarts.
- **HTTP API** — `POST /v1/evaluate`, agent + policy CRUD, decision reads. Zod-validated 400s, not 500s.

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
