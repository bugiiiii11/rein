# Changelog

Notable changes to the published `@reinconsole/*` packages: `core`, `sdk`, `gate`, `policy-engine`, `graph`, `erc8004`, `mock-rails`, `x402-rails`, `mcp`, `signer` and `store`. All eleven are versioned and released together. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

`0.3.0-rc.1` is a release candidate published under the npm `next` dist-tag (`npm i @reinconsole/sdk@next`). `latest` stays on `0.2.0` until 0.3.0 ships.

## [0.3.0-rc.1] - 2026-09-24

### Breaking

- **`@reinconsole/mcp` defaults to testnet.** `REIN_NETWORK_PROFILE` (`testnet` by default, or `mainnet`) limits both the guard and the payer to one network. A 402 that offers only the other network is refused before anything is signed. An unknown value stops the server at startup.
  *Upgrading:* a 0.2.0 install that paid Base mainnet 402s must set `REIN_NETWORK_PROFILE=mainnet`.
- **`createX402Payer` signs only for the pinned profile's USDC.** A requirement must name a network that has a pinned profile (Base or Base Sepolia, the same two networks the payer could sign for before) and that profile's USDC contract. Anything else throws `RailsError` with the code `unsupported_network` or the new `unsupported_asset`. Passing `profile` also restricts the payer to that one network.
  *Upgrading:* this payer can no longer pay in tokens other than USDC.
- **The engine ignores `intent.createdAt` when evaluating.** Rolling budgets, velocity limits, breakers, ledger timestamps and liveness sightings use the engine's own clock. `createdAt` is still stored and hashed, but it no longer affects any decision.
  *Upgrading:* code that set `createdAt` to move engine time (tests, backfills) should inject `EngineStores.now` instead.
- **Vendor-supplied `extra.decimals` and `extra.symbol` are no longer trusted.** The amount that policy evaluates is now scaled by the resolved asset's own decimals, and an offer whose `extra.decimals` disagrees with the token is skipped. `extra.symbol` is checked last and is never used to identify an EVM address, so an unknown token contract can no longer pass as `USDC`. `requirementDecimals` takes the resolved asset as an optional second argument.
  *Upgrading:* map custom token addresses with `GuardOptions.assetAddresses`. A 402 with no offer the guard can evaluate still raises `UnsupportedRequirementError`.
- **`GET /v1/decisions` is paged.** It returns at most 500 decisions by default, oldest first, and `?limit=` accepts up to 1000. On a longer chain, `EngineClient.decisions()` returns only that first page. The page still verifies on its own, but it is not the whole log.
  *Upgrading:* walk the full chain with `EngineClient.decisionsPage()` (see Added).
- **The standalone engine bins rate-limit by default.** `rein-policy-engine` and `rein-engine` return `429` with `Retry-After` when a client IP exceeds a burst of 30 requests or 1 per second, or when an API key exceeds a burst of 120 or 10 per second.
  *Upgrading:* tune the limits with `REIN_ENGINE_RATE_LIMIT_PER_IP`, `..._PER_IP_BURST`, `..._PER_KEY` and `..._PER_KEY_BURST`, or turn them off with `REIN_ENGINE_RATE_LIMIT=off`. Behind a reverse proxy, set `REIN_TRUST_PROXY`, or every caller shares one bucket. An embedded `buildServer` has no limiter unless you pass `rateLimit`.
- **Approvals must come from the agent's own org.** When a payment by a registered agent is escalated, the request is stamped with the agent's `orgId`. An approver key from a different org is refused with `403 approver_wrong_org`.
  *Upgrading:* register approvers under the same `orgId` as the agents they approve for.
- **`AllowanceGap.state` has a new value, `overspent`.** A 0.2.0 SDK's `EngineClient.reconciliation()` fails to parse a report from a 0.3.0 engine that contains such a row.
  *Upgrading:* upgrade `@reinconsole/sdk` together with the engine.

### Added

- **Network profiles** (`@reinconsole/x402-rails`): `TESTNET`, `MAINNET`, `PROFILES`, `profileFor`, `parseProfileName` (throws on unknown names) and `profileForNetwork`. A `NetworkProfile` holds the chain id, USDC address, EIP-712 domain, facilitator URL and explorer link for one network. `createX402Payer` accepts `networks` and `profile`.
- **Facilitator credentials** (`x402-rails`): `FacilitatorClientOptions.authHeaders` supplies headers for each request. `createProfileFacilitator` and `cdpAuthHeaders` wire up Coinbase CDP authentication, which needs `@coinbase/cdp-sdk` installed separately.
- **Resource discovery** (`x402-rails`): `discoverResources` and `selectDiscovered` read PayAI's public catalog (`PAYAI_DISCOVERY_URL`). They return, cheapest first, only offers that use the `exact` scheme, are on the profile's chain, pay in its USDC and point at a concrete URL.
- `OnchainIndexer.learnAllowed({ id, agentId })` and `allowedIntentIds()` let an indexer learn allowed intents from a remote engine. New wallet helpers: `addressForPrivateKey`, `createChainClient` and `getProfileUsdcBalance`.
- **Guard network allow-list** (`@reinconsole/sdk`): `GuardOptions.networks` accepts network ids in either x402 format and refuses offers on other networks before the engine is asked. Set it on any guard with a real key. Policy is written per chain and Base Sepolia counts as `base`, so the engine alone cannot tell testnet from mainnet. The guard also gains `maxReceipts` and `pendingTtlMs`.
- **Decision paging**: `after` and `limit` query parameters on `GET /v1/decisions`, plus the `Rein-Chain-Length` and `Rein-Next-After` response headers. `Rein-Next-After` is absent on the last page. `EngineClient.decisionsPage({ after, limit })` returns `{ decisions, nextAfter?, chainLength }`.
- **`agentId` on `/v1/decisions`**: each decision now includes the id of the agent it was about, typed as `AttributedDecision` in `@reinconsole/core`. The field is not signed and is not covered by `hash` or `signature`. Decisions recorded before 0.3.0 do not have it. `EngineClient.decisions()` and `decisionsPage()` return `AttributedDecision[]`.
- **Org-scoped API keys**: `ApiKey.orgId` limits a key to one org, and `agentIds` (up to 64) narrows it to specific agents. `EngineClient.issueApiKey` accepts `{ orgId?, agentIds? }`. A scoped key can read and change only its own org's agents, policies, decisions, reconciliation, approvals, approvers and keys. Another org's objects answer 404, and routes that do not support scoping answer `403 route_not_scopable`. Keys without an `orgId` work exactly as before. `Policy.orgId` and `ApprovalRequest.orgId` are new, and `policy-engine` exports the tenant helpers.
- **Overspend detection**: a settlement reported for more than its allowance appears as an `overspent` reconciliation row, listed first and carrying `settledAmount`. Reports gain `overspent` and `overspentValue` totals, which MCP's `rein_receipts` also shows.
- **`@reinconsole/core/auth`** subpath export: `ApiKeyAuth`, `AuthError` (with `AuthError.is()`), `InMemoryApiKeyStore`, `hashSecret`, `secretsEqual` and `readCredential`. It is a separate entry point so the main `@reinconsole/core` entry stays browser-safe. `policy-engine` still re-exports the auth symbols it had in 0.2.0. New `report` API-key scope.
- **Graph write auth**: `buildGraphServer(graph, { auth })` requires a key with the `report` scope on write routes, while reads stay open. Also new: `graphAuthFromEnv` (`REIN_GRAPH_API_KEY`) and `resolveGraphHost`.
- **Signer**: `buildSignerServer({ auth })` accepts an `ApiKeyAuth`. Listing grants needs `read`; minting, revoking and deleting need `admin`. `adminToken` still works.
- **Store**:
  - API keys are durable (`PgApiKeyStore`, `store.apiKeys`).
  - The engine's signing key can be kept outside the data directory with `openReinStore({ signingKey })`, or `REIN_ENGINE_SIGNING_KEY` on `rein-engine`. Only the public half is written to disk, and a different key is refused instead of starting a second chain.
  - New `installShutdown` and `startPeriodicPrune` helpers. The prune interval is set with `REIN_PRUNE_INTERVAL_MS` (default 30 minutes).
  - `startPersistentEngine` accepts `store`, `approvals`, `liveness`, `rateLimit` and `trustProxy`.
- **Engine**: `REIN_TRUST_PROXY` accepts `1` (same as `private`), `private`, a list of IPs or CIDR ranges, or `all`. Hop counts are rejected. `EngineStores.now` is new, and `TokenBucketLimiter` and the rate-limit helpers are exported.
- **Gate**: `GateRoute.discovery` publishes `input` and `output` schemas as `extensions.bazaar` on the v2 402 (see `bazaarExtension`). The header size limit is exported as `MAX_PAYMENT_HEADER_CHARS`.
- **MCP**: `rein_status` reports the active network. `networksFor` and `DEFAULT_NETWORK_PROFILE` are exported.

### Changed

- The guard's `receipts()` keeps only the 1000 most recent receipts (`maxReceipts`). `onReceipt` still sees every receipt.
- In advisory mode, the guard passes on a 402 that contains only the offer it evaluated, in both wire formats.
- The engine's HTTP server rejects request bodies over 64 KiB with 413 and waits at most 30 s for a request. Fastify's own 4xx errors are no longer reported as 500.
- Setting only one of `REIN_TELEGRAM_BOT_TOKEN` and `REIN_TELEGRAM_CHAT_ID` now stops the engine at startup.
- `reconcile({ graceMs: 0 })` now means no grace period: an allowance exactly at the grace boundary counts as unsettled.
- Policy ids are unique across orgs. Writing a `policyId` that another org owns returns `409 policy_id_taken`.
- The gate rejects payment headers over 16 KiB as `malformed_payment` before decoding them.
- `@reinconsole/graph`'s standalone server binds `127.0.0.1` unless `REIN_GRAPH_API_KEY` or `REIN_GRAPH_PUBLIC=1` is set. Setting a public `HOST` without either is a startup error.
- The bins shut down cleanly on `SIGTERM`/`SIGINT` and log the port they actually bound, so `PORT=0` works. When `rein-engine` starts as root, it takes ownership of its data directory and switches to the `node` user (`REIN_RUN_AS_USER`) before opening it.
- Store data directories are migrated automatically on open. Decisions recorded before the upgrade have no agent and are visible only to unscoped keys.
- The `fastify` dependency is now `^5.12.1`.

### Fixed

- `rein-engine` now runs the approval tier and the dead-man monitor. Previously, `/v1/approvals` returned 404 on the durable bin.
- On mainnet, when a vendor omits `extra.name`, the payer now signs with the EIP-712 domain name of Base USDC (`USD Coin`). Previously it used the Sepolia name, which the contract rejects at settlement.
- After a restart, the durable settlement store keeps the earliest report, the same as the in-memory store.
- `@reinconsole/mcp` reports its real package version. `SERVER_VERSION` had been hardcoded to `0.1.1`. `rein_fetch` also finds its receipt by identity instead of by position.

### Security

Five issues came out of the pre-mainnet review. The reasoning is in `SECURITY.md` under "Review history".

- The engine took its evaluation time from the caller-supplied `createdAt` (see Breaking).
- A vendor's `extra.decimals` could rescale the price that policy evaluated. The signer's voucher check now also takes decimals from the decision's asset.
- Any EIP-3009 token could present itself as USDC through `extra.symbol`.
- In advisory mode, the network allow-list could be bypassed through the offers in the unfiltered 402. It now passes on only the offer it evaluated.
- A key restricted to certain agents could rotate or revoke a less restricted key in its own org. Rotate and revoke now enforce the same restrictions as issuing a key.

Also in this release:

- Any registered approver could release any org's escalated payment. Such approvals now fail with `approver_wrong_org`.
- On `rein-engine`, keys issued through `POST /v1/keys` were lost on restart, and revoked keys came back. Keys are now stored durably.
- A plaintext signing key left in the data directory is erased once the same key is supplied from outside.
- The Telegram bot token no longer appears in request URLs, errors or logs.

## [0.2.0] - 2026-09-15

### Added

- First npm release of `@reinconsole/mcp`, `@reinconsole/signer` and `@reinconsole/store`:
  - `mcp` gives MCP harnesses a spend-governed fetch with the tools `rein_fetch`, `rein_status`, `rein_receipts`, `rein_escalations` and `rein_heartbeat`.
  - `signer` is the session-key custody tier, with a ten-day session ceiling and admin routes that require `adminToken` or `adminAuth: 'off'`.
  - `store` provides PGlite persistence and the `rein-engine` and `rein-graph` bins.
- Scoped engine API keys (`read`, `evaluate`, `approve`, `admin`) with rotation. The engine binds to loopback unless `REIN_ENGINE_API_KEY` is set.
- Signed human approvals for escalated payments (`EngineClient.awaitApproval`; `escalation: { await: true }` on the guard).
- Behavioral circuit breakers (`Policy.breakers`) and per-task budgets (`taskBudget`).
- Reconciliation of allowed but unsettled payments (`POST /v1/settlements`, `GET /v1/reconciliation`, guard settlement reporting).
- Dead-man liveness alarms (`watchLiveness`, `heartbeat`).
- Policy targeting by agent label (`appliesTo.labels`) and resource path (`resourceIn`).
- `createX402Payer` accepts an injected `account` instead of a raw private key.

## [0.1.1] - 2026-07-09

- x402 v2 wire support: the guard pays v2 402s, and the vendor side serves v1 and v2 together. `@reinconsole/erc8004` adds `setAgentUri`, `revokeFeedback` and `appendResponse`.

## [0.1.0] - 2026-07-04

- First public release on npm: `core`, `sdk`, `gate`, `policy-engine`, `graph`, `erc8004`, `mock-rails` and `x402-rails`.
