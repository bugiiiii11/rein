# Changelog

Notable changes to the published `@reinconsole/*` packages: `core`, `sdk`, `gate`, `policy-engine`, `graph`, `erc8004`, `mock-rails`, `x402-rails`, `mcp`, `signer`, `store` and `init`. All twelve are versioned and released together. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

## [0.6.0] - 2026-10-07

Sanctions screening and a geo-block on the engine, and the signer's replay burn keyed by the signed content. `Policy` loses two fields that were never read (`denyFloor`, `escalation`); stored policies that carry them still load.

### Fixed

- `@reinconsole/signer` burns a spent voucher by `decision.hash`, the content the engine signed, instead of `decision.id`. The id is outside the canonical form, so a copy of a used decision under a fresh id passed `verifyVoucher` and the replay check and was signed again; at-most-once then rested on the EIP-3009 nonce alone. The id is still consulted on the read side so burns recorded before the upgrade keep refusing. `SessionStorePort.burnDecision` / `unburnDecision` / `isDecisionUsed` now take that key.
- `parseTrustProxy` on `@reinconsole/policy-engine` refuses an IPv4-mapped `REIN_TRUST_PROXY` entry whose prefix is shorter than the 96 mapping bits (`::ffff:10.0.0.0/8` trusts nearly all of IPv6, not the 10/8 range it reads as). Write the IPv4 CIDR, or keep the mapping bits.

### Removed

- `denyFloor` and `escalation` (`approvers`, `timeoutAction`, `timeoutMin`) from the `Policy` schema in `@reinconsole/core`, and the `Escalation` export. They were declared and never read, and they described a fail-open floor and a timeout action the engine does not have: an unreachable engine signs nothing, and a parked escalation that reaches its TTL is denied. Unknown keys are stripped on parse, so stored policies that still carry them load unchanged.

### Added

- **Sanctions screening** on `@reinconsole/policy-engine` (`ServerOptions.screening`, `REIN_SANCTIONS_SCREENING` on `rein-engine`, on by default with the sandbox). At `POST /v1/claims/redeem`, and at a tenant's `POST /v1/keys` with `mainnet: true`, the engine checks the owner's wallet (for an `eth:` sign-in) and every wallet the org's agents registered against the Chainalysis sanctions oracle on Ethereum, through public RPCs tried in turn (`REIN_SANCTIONS_RPC_URLS` replaces the list). A listed address answers `403 screening_refused` and spends the claim code. If no RPC answers, the answer is `503 screening_unavailable` with `Retry-After: 60` and the code stays valid for a retry. Every check is kept, append-only and never pruned, in a new `screenings` table in `@reinconsole/store`, and unscoped keys read it at `GET /v1/screenings` (`?orgId=` filters). New exports: `ScreeningService`, `ScreeningError`, `InMemoryScreeningStore`, `chainalysisOracle`, `screenerFromEnv`, `ownerWallet`, `CHAINALYSIS_ORACLE`, `DEFAULT_SCREENING_RPCS` and their types.
- `screened` as a `mainnetOrgs` / `REIN_MAINNET_ORGS` entry: every claimed org that passes screening may go to mainnet without being listed by id. Listed orgs are screened too. It needs `screening`, and `buildServer` throws without it. The hosted default does not change.
- **A geo-block** on `@reinconsole/policy-engine` (`ServerOptions.geoBlock`, `REIN_GEOBLOCK` on `rein-engine` and the console, on by default with the sandbox on the engine and with sign-in on the console). A request from Cuba, Iran, North Korea, Crimea, Sevastopol, Donetsk or Luhansk answers `451 restricted_territory`. On the engine it runs before the rate limiter and auth, on every route but `/health`, by `req.ip` (so it needs `REIN_TRUST_PROXY=1` behind a proxy). `REIN_GEOBLOCK` takes `off`, `on` or a list of territory codes. The ranges come from DB-IP Lite (CC BY 4.0) and are bundled in the package, so a lookup sends no address anywhere; `scripts/update-geoblock.mjs` regenerates them. New exports: `GeoBlock`, `geoBlockFromEnv`, `clientAddress`, `privateAddress`, `DEFAULT_GEOBLOCK_TERRITORIES`, `GEOBLOCK_STATUS`, `GEOBLOCK_BODY`.

## [0.5.1] - 2026-10-06

The chain verified whole by the engine, mainnet gated per org, and `@reinconsole/mcp` ready for the MCP Registry. No breaking changes from `0.5.0`.

### Added

- `GET /v1/chain/verify` on `@reinconsole/policy-engine`: the engine's own verdict on its whole decision chain, `{ intact, visible, verifiedAt, brokenAt? }`. An org-scoped key reads a subsequence of one chain whose `prevHash` links lead to rows it cannot see, so `verifyDecisionChain` over its pages can only prove the links between visible rows; this route is the engine verifying every link without showing them. `visible` is the caller's own row count (the same number as `Rein-Chain-Length`); `brokenAt` goes to unscoped keys only. Verification is incremental in `DecisionLog.verify()`, so polling it costs the links appended since the last call. Also `chainBreakAt()`, the index-returning form of `verifyDecisionChain`, and `EngineClient.verifyChain()` in `@reinconsole/sdk`.
- `REIN_NOTIFY_ORGS` on `@reinconsole/policy-engine` and the `rein-engine` bin, and `OrgScopedChannel`: on a shared engine, only the listed orgs' escalations and dead-man alarms reach the operator's Telegram chat and log in full. Every other org gets an id-only log line and no Telegram message. Unset keeps the old behaviour: every org.
- `ServerOptions.mainnetOrgs` on `@reinconsole/policy-engine` and `REIN_MAINNET_ORGS` on the `rein-engine` bin: which orgs may take an agent to mainnet. `POST /v1/keys` accepts `mainnet: true`, which `init --mainnet` now sends; a tenant whose org is not listed gets `403 mainnet_not_enabled`. `any` lifts the gate. Unset: any org on an engine without the sandbox, no org on one with it. Unscoped keys are never gated. The engine still cannot see which network a payment is on; this gates the supported path.
- `examples/vercel-ai-sdk` and `examples/coinbase-agentkit`: spend limits for an x402 agent in two frameworks, a governed AI SDK `tool()` and an AgentKit action provider that signs with the AgentKit wallet. Both run against a free sandbox from `npx @reinconsole/init`.
- `services/mcp/server.json` and `mcpName` in `@reinconsole/mcp`'s package.json, for the official MCP Registry (`io.github.bugiiiii11/rein`).
- `init --claim` waits for the sign-in (up to the code's 10 minutes) and prints `Claimed: org ... is yours` when the `owner:` key appears, instead of ending on the link. `runClaim` returns `claimed` and takes `waitMs` / `pollMs`.

### Changed

- `GET /v1/policies` for an org-scoped key no longer lists a global policy that targets only other orgs' agents (`readablePolicies` takes an agent-to-org lookup). Such a policy never governed the caller; listing it leaked other orgs' agent ids and inflated the console's "N active".
- `@reinconsole/mcp`'s README leads with `npx @reinconsole/init` and `REIN_AGENT_FILE`, which it did not mention, and no longer says the hosted engine is invitation-only.
- The console's agent card shows a dash for spend and calls when the source does not publish them (the hosted engine), instead of `$0.00 / 0` beside a settled payment.

## [0.5.0] - 2026-10-01

Owners can claim a sandbox and take its agent to Base mainnet. No breaking changes from `0.4.0`.

### Added

- **Claiming a sandbox** on `@reinconsole/policy-engine` (`ServerOptions.claims`, on whenever the sandbox is). `POST /v1/claims` with a sandbox's org-wide admin key returns a one-time code that is valid for 10 minutes. `POST /v1/claims/redeem` binds the org to a signed-in identity (`github:<id>` or `eth:<address>`) and lifts the expiry and quotas on the org's keys. `POST /v1/owners/session` returns a 12-hour org-scoped `read` key for the owner. Both of these calls need the new `identity` scope on an unscoped key. The binding is an `owner:<identity>` key whose secret is discarded. It is visible in `GET /v1/keys`, and revoking it releases the org. One org per identity. Key names starting `owner:` or `session:` are reserved.
- `ApiKeyAuth.clearExpiry(keyId)` in `@reinconsole/core`.
- **`init --claim`**: gets a claim code with the key in `rein-agent.json` and opens the console's `/claim` page in the browser. The key itself is never put in the URL.
- **`init --mainnet`**: moves a claimed org's agent to Base mainnet. It refuses an org that has not been claimed. It writes the org admin key and a new ed25519 approver key to `~/.rein/owner-<orgId>.json` (mode 0600), registers the approver, and replaces the key in `rein-agent.json` with one that is narrowed to the agent and limited to `evaluate` + `read`. With that key the agent cannot change its policy, mint keys or sign approvals. The engine does not know which network a payment is on, so this gate is enforced by the client and backed by the 7-day expiry on unclaimed keys.
- **`init --approve <decisionId>` / `--reject`**: shows a parked escalation, and with `--yes` signs it with the owner's approver key and submits it.

### Fixed

- `ApiKeyAuth`: a `lastUsedAt` update that raced a rotate or revoke could write back a stale record and un-revoke a key.

### Changed

- `init --force` refuses to overwrite a `rein-agent.json` that is on mainnet, because that file holds the only copy of the wallet key.

## [0.4.0] - 2026-09-30

`@reinconsole/init` is new, so the set is now twelve packages. No breaking changes from `0.3.0`.

### Added

- **`@reinconsole/init`**, a new package: `npx @reinconsole/init` creates a sandbox on the hosted engine (no account, testnet, 7 days), writes `rein-agent.json` (agent, key and a wallet generated on your machine, file mode 0600, added to an existing `.gitignore`), waits for the test-USDC drip, then makes one allowed and settled call and one call the starter policy refuses. Options: `--engine`, `--vendor`, `--force`, `--no-demo`.
- **`POST /v1/sandbox`** on `@reinconsole/policy-engine` (`ServerOptions.sandbox`, `REIN_SANDBOX=1` on `rein-engine`): unauthenticated, mints an org, one agent, a starter policy (per-call cap $0.004, 24h budget $0.05) and an org-scoped key that expires after 7 days. Limits: per IP (`REIN_SANDBOX_PER_IP_PER_DAY`, default 5), per day globally (`REIN_SANDBOX_DAILY_CAP`, default 200, counted from issued keys so it survives restarts), 3 agents and 500 decisions per rolling 24h per sandbox org (`429 sandbox_quota`). With `REIN_SANDBOX_FAUCET_KEY` it drips `REIN_SANDBOX_DRIP_USDC` (default 0.05) Base Sepolia USDC to the caller's wallet.
- **API keys can expire:** `ApiKey.expiresAt`, `ApiKeyAuth.issue({ expiresAt })`, and a `401 key_expired` past it. A key minted by an expiring key inherits its deadline. The key name `sandbox` is reserved (`400 reserved_key_name`).
- **`createUsdcFaucet`** in `@reinconsole/x402-rails`: Base Sepolia only, with no option that points it at mainnet.
- **`REIN_AGENT_FILE`** for `@reinconsole/mcp`: read the engine URL, agent, key, payer and network from the `rein-agent.json` init writes. An explicit env var still wins.
- **`@reinconsole/store` runs on a network Postgres** as well as PGlite. Pass `openReinStore({ databaseUrl, schema })`, or set `DATABASE_URL` (plus optional `REIN_DB_SCHEMA`) for `rein-engine`. The driver keeps one serialized connection, so statements land in issue order as they do on PGlite. A network store requires an external signing key (`signingKey` / `REIN_ENGINE_SIGNING_KEY`) and stores only the public half. New exports: `openNetworkDb`, `PgNetworkDb`, `Db`, `Queryable`, `NetworkDbOptions`.
- **PGlite to Postgres migration.** Set `REIN_MIGRATE_FROM=<data dir>` beside `DATABASE_URL` and `rein-engine` copies the directory at boot, carrying `seq` values over and blanking the private key. It then checks row counts, byte-identical decision docs, the chain and reconciliation, and refuses to serve if any check fails. The source directory is only read. On a re-run it copies nothing. A target that does not continue the source chain is refused.
- `ReinStoreOptions.pruneOnOpen` (default `true`).

## [0.3.0] - 2026-09-29

0.3.0 is `0.3.0-rc.1` plus the additions below. Every breaking change, addition and fix listed under `0.3.0-rc.1` also applies to an upgrade from `0.2.0`, so read both sections before upgrading.

### Added

- **Surge pricing for `@reinconsole/gate`** (`GateOptions.surge`), a profit guard for sellers whose facilitator bills them per settlement. Routes quote `max(list price, multiplier x settlement cost)` (multiplier default `2`), rounded up to the asset's smallest unit. Above `ceiling x list price` (default `5`) the gate answers `503 price_ceiling` with `Retry-After` instead of quoting. When the cost is unknown it answers `503 price_unavailable` and never falls back to the list price. A payment anywhere from the current quote up to the ceiling is accepted and settles at its own value, so a payment signed against an earlier, higher quote still goes through. Both new refusal codes are no-fault in `@reinconsole/graph`. `quoteFor()` still returns the list price.
- **`facilitatorClientRails` retries a settle once when the facilitator's own transaction lost a nonce race** (`replacement transaction underpriced` or `nonce too low`), after 1.5 s (`retryDelayMs` option). The RPC refused the facilitator's transaction at broadcast, so the payer's authorization was never used. EIP-3009 still guarantees at-most-once on-chain. `already known` is not retried, because that transaction may still land.
- **`settlementCostOracle`** (`@reinconsole/gate`): `max(facilitator's published rate, gas price x gas units x Chainlink ETH/USD x markup)`, cached 15 s, with concurrent callers sharing one read. A stale or non-positive feed answer, a failed RPC call or a missing rate throws. Also new: `BASE_ETH_USD_FEED`, `PAYAI_PRICING_URL`, `surgeQuote`, `ceilAtomic`, `validateSurge`.

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
