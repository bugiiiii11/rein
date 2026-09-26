# @reinconsole/store

The persistence layer of **[Rein](https://github.com/bugiiiii11/rein)** — the control plane for AI agent payments. Postgres-backed stores (embedded [PGlite](https://pglite.dev) — no Docker, no daemon, upgradeable to hosted Postgres) behind every service's store ports, so the whole stack survives a restart: agents, policies, spend, the signing key, the hash-chained decision log, reputation evidence, gate receipts and signer sessions.

> **Status: v0.3 — early open-source infrastructure, live on testnet.** APIs may change before 1.0. See it running: [Rein console](https://app.reinconsole.com).

## Install

```bash
npm install @reinconsole/store
```

## Quickstart

One call opens (or creates) the database, loads or generates the signing key, and resumes the decision chain from the last persisted hash:

```ts
import { openReinStore } from '@reinconsole/store';
import { PolicyEngine } from '@reinconsole/policy-engine';

const store = await openReinStore({ dir: './data' }); // omit dir for ephemeral in-memory (tests)

// ReinStore structurally satisfies the engine's EngineStores, so a durable engine is one line:
const engine = new PolicyEngine(store);

console.log(store.fresh, store.resumedDecisions, store.resumedSessions, store.resumedReceipts);
```

The same open backs the rest of the stack: `store.ledger` / `store.intents` for `new ReputationGraph(...)`, `store.sessions` for `new SessionSigner({ store })`, `store.gate` for `createGate({ store })` — one PGlite database, every service's state.

Some ports are deliberately **half** a component: `livenessStore` and `approvalStore` are the persistent halves of `LivenessMonitor` and `ApprovalService`. Compose them yourself (`new ApprovalService({ store: s.approvalStore })`) — the delivery channels and TTLs are policy choices a store must not make.

## Standalone bins

Two ready-made services ship with the package, both **fail-closed**:

```bash
npx -p @reinconsole/store rein-engine   # durable policy engine
npx -p @reinconsole/store rein-graph    # durable reputation graph
```

| Bin | Default posture | To expose it |
| --- | --- | --- |
| `rein-engine` | No key set → loopback only. A public bind without a key is a **startup error** | `REIN_ENGINE_API_KEY=<secret>` (or `REIN_ENGINE_AUTH=off` to accept an open engine deliberately) |
| `rein-graph` | No key set → loopback only. A public bind without a key is a **startup error**. With a key, the **write** routes demand the `report` scope and reads stay open | `REIN_GRAPH_API_KEY=<secret>` (comma-separated for several), or `REIN_GRAPH_PUBLIC=1` (the literal string) to expose an open graph deliberately |

Data directories: `REIN_DATA_DIR` / `REIN_GRAPH_DATA_DIR`. Directories this package creates are made `0700` on POSIX — `engine_keys.private_pem` lives in one, and the default umask would leave it world-readable. Existing directories are **not** re-chmodded; tighten those by hand.

## How it behaves

- **The approval tier and the dead-man run on the bin too.** `rein-engine` composes both on `approvalStore` / `livenessStore` from env (`REIN_ESCALATION_TTL_MS`; `REIN_TELEGRAM_BOT_TOKEN` + `REIN_TELEGRAM_CHAT_ID`, both or neither), so a parked payment survives a restart on its original clock and a silent agent is noticed. An embedded `startPersistentEngine` call passes its own `approvals` / `liveness`, or gets an engine with no tier.
- **The chain resumes, and verifies across the seam.** The next append continues from the last persisted hash, and the log verifies end to end over the restart boundary — a restart is not a fresh chain.
- **Scores are never stored.** The reputation graph persists raw *evidence*; scores recompute byte-identically from rehydrated evidence. In-flight intent correlations persist too, so a settlement landing after a restart is still attributed.
- **Replay protection is durable.** A gate payment settled before a restart is refused as a replay after it, and a signer voucher burned before a restart stays burned.
- **Wallet private keys are deliberately never here.** The signer re-registers them at boot; the engine's own signing key is a plaintext PEM in the `0700` data dir by default (the single-node posture), or held outside it entirely with `openReinStore({ signingKey })` / `REIN_ENGINE_SIGNING_KEY` on the bin -- then only the public half is on disk, a plaintext copy from an earlier boot is erased, and a different key is refused rather than allowed to fork the chain.
- **API keys are durable, and revocations with them.** `store.apiKeys` backs an `ApiKeyAuth` (`new ApiKeyAuth({ store: reinStore.apiKeys })`): an issued key still authenticates after a restart, a revoked one stays dead, and a rotation's grace window resumes on its original deadline rather than being cut short. Rows are sha256 digests, never secrets. Without this the failure is silent and points the wrong way — a key withdrawn after a leak comes back alive on the next boot.
- **The bins drain on SIGTERM.** Every container runtime stops a deploy with a signal and kills what is left seconds later. `installShutdown` (`src/lifecycle.ts`) closes the server and then the store, so the write-behind tail -- reputation evidence, gate telemetry, API-key usage touches -- is flushed instead of dying with the process. A wedged drain is abandoned after 10s and exits non-zero, because a shutdown that cannot flush must not look like one that did.

## Retention

`store.prune()` TTL-drops the three tables that would otherwise grow forever. It runs once at open, and the bins re-run it every 30 minutes (`REIN_PRUNE_INTERVAL_MS`, `0` to disable) -- a boot-time-only sweep covers a service that restarts often and leaves one that stays up accreting for as long as it stays healthy, which is exactly backwards.

| Table | Pruned after | Why it is safe to drop |
|-------|--------------|------------------------|
| `signer_used_decisions` | 1 h | A burned voucher is dead once the signer's 300s staleness window has long passed. |
| `gate_replays` | 24 h | A replay slot is dead once the payment's on-chain authorization (~300s) has expired. Generous because MOCK rails have no expiry -- see `PgGateStore.pruneReplays`. |
| `approval_requests` (RESOLVED only) | 7 d | The decision chain is the authoritative record of what was approved; these rows are a convenience copy for the console panel. |

**PENDING approval requests are never pruned, at any TTL.** A lapsed escalation is still owed its deny on the chain.

**Never pruned, at any age:** `decisions`, `spend_records`, `settlements`, `breaker_resets`, `agent_liveness`, `api_keys`. These are not history, they are the state the engine reasons from -- a pruned decision breaks the hash chain, a pruned spend record refills a budget, a pruned reset re-trips a breaker somebody already answered for, and a pruned key resurrects a revocation.

## Single node, by construction

One engine per data directory. PGlite admits a single writer, so this is not a tuning choice:

- `numReplicas: 1`. Two replicas on one volume is data corruption, not contention.
- No overlapping deploys. The old process must exit before the new one opens the directory.
- To scale, SHARD tenants across engines (one data dir each) rather than adding replicas to one.

MIT © Rein contributors · [Repository](https://github.com/bugiiiii11/rein) · [Issues](https://github.com/bugiiiii11/rein/issues)
