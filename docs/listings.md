# Listings (Sprint 14.2)

Where Rein is listed, what each listing says, and what it is waiting on. Every submission below is public and made under the founder's GitHub account, so each one needs an explicit go.

## Shared copy

- **Name:** Rein
- **One line (under 100 chars):** Spend limits for AI agents that pay with x402: every paywall is policy-checked before a cent moves.
- **Short description:** Rein is the control plane for AI agent payments. Wrap your agent's fetch, or add the MCP server, and every x402 payment is checked against your policy before anything is signed: per-call caps, budgets, allow and deny lists, human approval, and a kill switch. Every decision is signed and receipted. Non-custodial: Rein governs the authority to spend, never the funds. Try it free on testnet with `npx @reinconsole/init`.
- **Website:** https://reinconsole.com
- **Repo:** https://github.com/bugiiiii11/rein
- **npm:** `@reinconsole/mcp` (MCP server), `@reinconsole/sdk` (fetch guard), `@reinconsole/init` (sandbox)
- **Logo:** `apps/landing/favicon.svg` (a PNG export is still needed for x402.org)

## MCP

| Target | How | Status |
|---|---|---|
| Official MCP Registry | `services/mcp/server.json` (validated against the 2025-12-11 schema) + `mcpName: io.github.bugiiiii11/rein` in `services/mcp/package.json`. The registry checks `mcpName` in the PUBLISHED package, so **0.5.1 must be released first**. Then: `mcp-publisher login github` and `mcp-publisher publish` from `services/mcp/`. | 0.5.1 released 2026-10-06 with `mcpName`; `mcp-publisher validate` passes against the live registry; waits on the founder's `login github` + `publish` |
| PulseMCP | Ingests the official registry automatically. | follows the registry |
| Glama | Indexes public GitHub MCP servers; claim the listing at glama.ai/mcp/servers with GitHub to edit it. | check after the registry |
| Smithery | smithery.ai, "Add server", from the GitHub repo (stdio, `npx -y @reinconsole/mcp`, env `REIN_AGENT_FILE`). | form |
| mcp.so | mcp.so "Submit", with the shared copy. | form |
| awesome-mcp-servers | PR to `punkpeye/awesome-mcp-servers`, section "Finance & Fintech". Entries there carry a Glama score badge, so **Glama comes first**. Line: `- [bugiiiii11/rein](https://github.com/bugiiiii11/rein) [![bugiiiii11/rein MCP server](https://glama.ai/mcp/servers/bugiiiii11/rein/badges/score.svg)](https://glama.ai/mcp/servers/bugiiiii11/rein) [TS] [cloud] [local] - Spend limits for AI agents that pay with x402: every paywall is policy-checked (caps, budgets, approvals, kill switch) before a cent moves.` (swap `[TS] [cloud] [local]` for the list's legend emojis for TypeScript, cloud service and local service when opening the PR) | PR, after Glama |

## x402

| Target | How | Status |
|---|---|---|
| x402.org ecosystem | PR to `coinbase/x402`: `typescript/site/app/ecosystem/partners-data/rein/metadata.json` + `typescript/site/public/logos/rein.png`. Category `Infrastructure & Tooling`. Metadata below. | needs logo PNG |
| awesome-x402 | PR with one line in the tooling section, from the shared one-liner. | PR |
| PayAI catalog (vendor) | The reference vendor is already discovered keyless via PayAI on mainnet (S78), but the mainnet lane is DISARMED (legal decision 2026-10-05). Decided 2026-10-06: WAIT. A testnet-only entry brings no buyers, and a mainnet entry would advertise a service the operator may not charge for. Revisit once the non-UAE fee entity exists. | waiting |
| ERC-8004 (vendor + runner) | Decided 2026-10-06: Base Sepolia now, mainnet later. Vendor = `eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e/9587` (`scripts/register-vendor-8004.mjs`, self-referenced); the demo agent was already `#7393`. Mainnet identities (vendor, runner) wait for the vendor to be allowed to charge. | testnet done |

```json
{
  "name": "Rein",
  "category": "Infrastructure & Tooling",
  "logoUrl": "/logos/rein.png",
  "description": "Spend control for AI agents that pay with x402. Wrap the agent's fetch (or add the MCP server) and every payment is checked against a policy before anything is signed: per-call caps, budgets, allow and deny lists, human approval, kill switch. Signed decisions, receipts and reconciliation against the chain. Non-custodial: governs the authority to spend, never the funds. Free testnet sandbox: npx @reinconsole/init.",
  "websiteUrl": "https://reinconsole.com"
}
```
