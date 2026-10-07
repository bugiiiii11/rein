# Listings (Sprint 14.2)

Where Rein is listed, what each listing says, and what it is waiting on. Every submission below is public and made under the founder's GitHub account, so each one needs an explicit go.

## Shared copy

- **Name:** Rein
- **One line (under 100 chars):** Spend limits for AI agents that pay with x402: every paywall is policy-checked before a cent moves.
- **Short description:** Rein is the control plane for AI agent payments. Wrap your agent's fetch, or add the MCP server, and every x402 payment is checked against your policy before anything is signed: per-call caps, budgets, allow and deny lists, human approval, and a kill switch. Every decision is signed and receipted. Non-custodial: Rein governs the authority to spend, never the funds. Try it free on testnet with `npx @reinconsole/init`.
- **Website:** https://reinconsole.com
- **Repo:** https://github.com/bugiiiii11/rein
- **npm:** `@reinconsole/mcp` (MCP server), `@reinconsole/sdk` (fetch guard), `@reinconsole/init` (sandbox)
- **Logo:** `apps/landing/favicon.svg` and its 512 px PNG render `services/mcp/mcpb/icon.png` (Smithery icon; the x402 logo slot no longer exists)

## MCP

| Target | How | Status |
|---|---|---|
| Official MCP Registry | `services/mcp/server.json` (validated against the 2025-12-11 schema) + `mcpName: io.github.bugiiiii11/rein` in `services/mcp/package.json`. The registry checks `mcpName` in the PUBLISHED package, so **0.5.1 must be released first**. Then: `mcp-publisher login github` and `mcp-publisher publish` from `services/mcp/`. | LIVE: `io.github.bugiiiii11/rein` 0.6.0 (published 2026-10-07; 0.5.1 on 2026-10-06) |
| PulseMCP | Ingests the official registry automatically. | follows the registry |
| Glama | Indexed and claimed (2026-10-06). The score badge needs a passing build: admin/dockerfile with Node 22, build `["npm install -g @reinconsole/mcp@<ver>"]` (bump the pin in Glama admin on each release -- 0.6.0 pending), CMD `["rein-mcp"]`, placeholders `REIN_ENGINE_URL=https://engine.reinconsole.com` + `REIN_AGENT_ID=agt_01JZZZZZZZZZZZZZZZZZZZZZZZ` (boots advisory, lists 5 tools, never calls the engine), then Deploy + Make Release. | LIVE: build passed, release published 2026-10-06 (labelled 0.1.0), Auto-Release on, discovery score 58% |
| Smithery | Local stdio servers are published ONLY as an MCPB bundle (URL publishing means hosting -- never, the server holds the agent's keys). Bundle: `npm install @reinconsole/mcp@<ver> --omit=dev` into an empty dir, copy in `services/mcp/mcpb/manifest.json` (bump `version`) + `icon.png`, then `npx @anthropic-ai/mcpb pack <dir> rein-<ver>.mcpb`. One required user setting: the `rein-agent.json` path, passed as `REIN_AGENT_FILE` (no optional env vars: an empty one would override the file). The web form takes URLs only: publish with `npx -y smithery@latest auth login` then `npx -y smithery@latest mcp publish <file>.mcpb -n bugiiiii/rein` (namespace is `bugiiiii`, from the account email). GOTCHA: Smithery turns the manifest's `tools` into its server card and 400s ("expected object, received undefined" once per tool) unless every tool has an `inputSchema` -- which the MCPB schema REJECTS. So pack the valid bundle, then rewrite `manifest.json` inside a COPY with each tool's `inputSchema` + `annotations` from a live `tools/list` (Python `zipfile`, copying every other entry). | LIVE: https://smithery.ai/servers/bugiiiii/rein, 0.6.0 bundle released 2026-10-07 (release 8d90d77b) ("Local" deployment, 75/100 after name, icon and description were set in its Settings) |
| mcp.so | mcp.so "Submit", with the shared copy. The page claims "free review", but on 2026-10-06 only the $39 paid option was selectable (its box cannot be unticked). | not paying; support ticket asking for free review SENT 2026-10-06 |
| awesome-mcp-servers | PR to `punkpeye/awesome-mcp-servers`, section "Finance & Fintech". Entries there carry a Glama score badge, so **Glama comes first**. Line: `- [bugiiiii11/rein](https://github.com/bugiiiii11/rein) [![bugiiiii11/rein MCP server](https://glama.ai/mcp/servers/bugiiiii11/rein/badges/score.svg)](https://glama.ai/mcp/servers/bugiiiii11/rein) <legend tags> - Spend limits for AI agents that pay with x402: every paywall is policy-checked (per-call caps, budgets, human approval, kill switch) before a cent moves, with signed receipts.` | PR #15847 OPEN 2026-10-06 (legend tags used: TypeScript, cloud service, macOS, Windows, Linux; title carries the list's three-robot agent fast-track marker) |

## x402

| Target | How | Status |
|---|---|---|
| x402 docs (was "x402.org ecosystem") | `coinbase/x402` is now a fork of `x402-foundation/x402`, and the logo-card ecosystem site was deleted 2026-07 (#2794). The curated list is now `docs/dev-tools/third-party-extensions.md` (docs.x402.org/dev-tools). Commits MUST be signed: the REST contents API gives `verified=false`, so commit via GraphQL `createCommitOnBranch` (GitHub signs it). Merges are slow (1 outside merge since May, 8+ open). | PR #3709 OPEN 2026-10-06 |
| awesome-x402 | `xpaysh/awesome-x402`, "Agent Verification & Security", bottom of the section (its rule); format `- [Name](link) - Description.` | PR #1740 OPEN 2026-10-06 |
| PayAI catalog (vendor) | The reference vendor is already discovered keyless via PayAI on mainnet (S78), but the mainnet lane is DISARMED (legal decision 2026-10-05). Decided 2026-10-06: WAIT. A testnet-only entry brings no buyers, and a mainnet entry would advertise a service the operator may not charge for. Revisit once the non-UAE fee entity exists. | waiting |
| ERC-8004 (vendor + runner) | Decided 2026-10-06: Base Sepolia now, mainnet later. Vendor = `eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e/9587` (`scripts/register-vendor-8004.mjs`, self-referenced); the demo agent was already `#7393`. Mainnet identities (vendor, runner) wait for the vendor to be allowed to charge. | testnet done |

x402 docs row as submitted: `| [Rein](https://reinconsole.com) | Pre-signature spend limits, human approvals and signed receipts for paying agents | TypeScript | [GitHub](https://github.com/bugiiiii11/rein) · [npm](https://www.npmjs.com/package/@reinconsole/sdk) |`
