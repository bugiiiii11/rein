# @reinconsole/policy-engine

The rule engine of **[Rein](https://github.com/bugiiiii11/rein)** — the control plane for AI agent payments. A sandboxed, declarative policy engine that judges every payment intent (`deny > escalate > allow > default`), with every decision ed25519-signed and sha256 hash-chained into a tamper-evident audit log.

> **Status: v0.1 — early open-source infrastructure, live on testnet.** APIs may change before 1.0. See it running: [Rein console](https://app.reinconsole.com).

## Install & run

```bash
npm install @reinconsole/policy-engine
# or just run it:
npx -p @reinconsole/policy-engine rein-policy-engine   # HTTP API on 127.0.0.1:8787

# to expose it, give it a key first:
REIN_ENGINE_API_KEY=rk_your_secret HOST=0.0.0.0 npx -p @reinconsole/policy-engine rein-policy-engine
```

An engine with no `REIN_ENGINE_API_KEY` binds **loopback only**, and refuses to
start on a public interface — an unauthenticated engine cannot be exposed by
accident. `REIN_ENGINE_AUTH=off` is the deliberate override.

Point [`@reinconsole/sdk`](https://www.npmjs.com/package/@reinconsole/sdk)'s guard at it (`engineUrl`) and every x402 paywall your agent hits is evaluated here first.

## In-process

```ts
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';

const engine = new PolicyEngine();      // in-memory stores by default
const app = buildServer(engine);        // Fastify instance (not yet listening)
await app.listen({ port: 8787 });
```

## Approvals in practice

```ts
import { PolicyEngine, ApprovalService, TelegramApprovalChannel, signApproval } from '@reinconsole/policy-engine';

const approvals = new ApprovalService({
  ttlMs: 600_000,                       // unanswered after 10 min = denied
  channels: [new TelegramApprovalChannel({ botToken, chatId })],
});
const engine = new PolicyEngine({ approvals });
engine.startExpirySweeper();            // lapsed escalations become deny decisions

// Register the PUBLIC half of an approver key; the private half never travels.
await approvals.registerApprover({ orgId, name: 'Finance', publicKey: pem });

// Offline, wherever the private key lives:
const signature = signApproval(privateKey, { decisionId, intentHash, verdict: 'approve' });
// POST /v1/approvals/:decisionId/resolve  { intentHash, verdict, approverKeyId, signature }
```

Environment for the standalone server: `REIN_ESCALATION_TTL_MS`,
`REIN_TELEGRAM_BOT_TOKEN`, `REIN_TELEGRAM_CHAT_ID`.

## What it does

- **Declarative policies** — budgets over rolling windows, per-tx caps, vendor allow/deny lists by glob, escalation, and reputation rules (`vendorReputationLt`, fed by [`@reinconsole/graph`](https://www.npmjs.com/package/@reinconsole/graph)). Precedence is `deny > escalate > allow > default`.
- **Kill switch** — freeze an agent and there is no allow; the check happens before evaluation.
- **Signed decisions** — each decision commits to the exact intent it judged (`intentHash`), is ed25519-signed, and links to the previous decision's hash. `verifyDecisionChain` validates the whole history offline; the `{intent, decision}` pair is a self-contained spend voucher downstream tiers verify without calling back.
- **Store ports** — agents, policies, rolling spend, and the decision log sit behind injectable ports (`SpendStorePort`, `PolicyStorePort`, `AgentRegistryPort`). In-memory implementations ship here; the durable Postgres-backed variant lives in the [monorepo](https://github.com/bugiiiii11/rein) (`@reinconsole/store`) and keeps the hash chain continuous across restarts.
- **API-key auth** — every route but `/health` needs `Authorization: Bearer <secret>`. Keys are scoped (`read`, `evaluate`, `approve`, `admin`; `admin` satisfies all), stored only as sha256 digests, and rotatable with a grace window so a fleet rolls over without a flag-day restart. Unauthenticated is 401 with a challenge, wrong-scope is 403 — never a silent pass. Any route not explicitly classified requires `admin`, so a new endpoint is over-protected rather than open.
- **Signed approvals** — an `escalate` outcome parks the payment instead of merely blocking it. An approval is an ed25519 **signature over `decisionId + intentHash`** by a key registered with the engine; the delivery channel (Telegram, logs, your own) is transport and carries no authority, so there is no click-to-approve anywhere. A signed approval appends an **allow** decision for the same intent (the escalation itself is never rewritten — the chain only grows), a signed rejection or a TTL lapse appends a **deny**. Fail closed: unanswered means denied.
- **HTTP API** — `POST /v1/evaluate`, agent + policy CRUD, decision reads, `/v1/keys` (issue/rotate/revoke), `/v1/approvers`, `/v1/approvals`. Zod-validated 400s, not 500s.

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
