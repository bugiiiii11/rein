# @reinconsole/mcp

The Rein guard, as an MCP server. Point any MCP-capable harness at it and its agent gets a
spend-governed fetch: every x402 paywall is policy-checked, receipted and observable before a cent
moves.

Rein is non-custodial. It governs an agent's authority to spend, not the funds.

## Install

```json
{
  "mcpServers": {
    "rein": {
      "command": "npx",
      "args": ["-y", "@reinconsole/mcp"],
      "env": {
        "REIN_ENGINE_URL": "http://127.0.0.1:8787",
        "REIN_AGENT_ID": "agt_01J..."
      }
    }
  }
}
```

That is advisory mode: paywalls are evaluated against policy and reported, and nothing is ever
paid. Add `REIN_PAYER_PRIVATE_KEY` to settle allowed payments.

You need a policy engine to point at. `npx @reinconsole/policy-engine` runs one locally; see
[@reinconsole/policy-engine](https://www.npmjs.com/package/@reinconsole/policy-engine) for
registering an agent and writing a policy.

## Environment

| Variable                      | Required               | Meaning                                                                       |
| ----------------------------- | ---------------------- | ----------------------------------------------------------------------------- |
| `REIN_ENGINE_URL`             | yes                    | Policy engine base URL.                                                       |
| `REIN_AGENT_ID`               | yes                    | The one agent this server speaks for. Never a tool argument.                  |
| `REIN_ENGINE_API_KEY`         | if the engine has auth | Bearer secret for the engine.                                                 |
| `REIN_PAYER_PRIVATE_KEY`      | no                     | Agent wallet key. Omit for advisory mode: policy is checked, nothing is paid. |
| `REIN_MCP_TASK_ID`            | no                     | Default task attribution, so per-task budgets can cap this agent's work.      |
| `REIN_MCP_ESCALATION_WAIT_MS` | no                     | Hold a tool call open this long waiting for a signed approval. Default `0`.   |
| `REIN_MCP_MAX_BODY_BYTES`     | no                     | Cap on the response body returned to the model. Default 65536.                |

Everything is fixed at startup. Nothing here is reachable from a tool call.

## Tools

| Tool               | Read-only | What it answers                                                 |
| ------------------ | --------- | --------------------------------------------------------------- |
| `rein_fetch`       | no        | Fetch a URL, paying for it only if policy allows.               |
| `rein_status`      | yes       | What rules govern this agent, and where it stands against them. |
| `rein_receipts`    | yes       | What it has paid, and whether those payments settled.           |
| `rein_escalations` | yes       | Which of its payments are parked awaiting a human.              |
| `rein_heartbeat`   | no        | Report the agent alive, for dead-man monitoring.                |

`rein_fetch` is the only tool that can move money, and it is the only one without `readOnlyHint`.

## The authority boundary

The client on the other end of this pipe **is the agent** -- the thing being governed. So a tool may
do anything the agent could already do with its own fetch, and nothing that widens the agent's own
authority.

There is deliberately no tool to approve an escalation, edit a policy, freeze or unfreeze an agent,
mint an API key, or register an approver. An approval in Rein is an ed25519 signature over the
decision by a registered approver key; a tool call is not a signature, and one that stood in for one
would put the authority to move money behind whatever process holds the pipe. `rein_escalations` is
read-only by construction, and a test asserts the whole tool surface rather than a sample of it, so
adding an authority tool has to break a test first.

One server also speaks for exactly one agent. An agent id the caller could choose would turn an
agent-scoped tool surface into a cross-agent admin API.

## What a blocked payment looks like

A policy refusal comes back as a tool **error** -- the fetch did not happen, and a model that read it
as an ordinary result would treat the explanation of a refusal as the data it asked for. The detail
rides along, because the useful next move depends on which refusal it was:

- `DENIED` -- final. The same request will be refused the same way.
- `ESCALATED` -- parked for a human to sign. Poll `rein_escalations`, or move on. Nothing the agent
  can call will approve it.
- `ALLOWED_BUT_UNPAID` -- not an error: policy said yes, but this server runs in advisory mode, so
  the 402 is returned unpaid.

## Programmatic use

```ts
import { createReinMcpServer } from '@reinconsole/mcp';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const server = createReinMcpServer({ engineUrl, agentId, payer });
await server.connect(new StdioServerTransport());
```

`createToolContext` and `reinTools` are exported too, for embedding the same tools in a server that
carries others.

## License

MIT
