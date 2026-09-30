# @reinconsole/init

A Rein sandbox in one command. No account, no faucet form, testnet only.

```
npx @reinconsole/init
```

It:

1. generates a wallet on your machine (the private key never leaves it);
2. creates a sandbox on the hosted engine at `engine.reinconsole.com`: an org, an agent, a starter
   policy (at most $0.004 per call, $0.05 per 24 hours) and an API key that expires in 7 days;
3. writes `rein-agent.json` in the current directory, file mode 0600, and adds it to an existing
   `.gitignore`, because it holds your keys;
4. waits for a few cents of test USDC to reach the wallet (Base Sepolia);
5. makes a $0.001 call the policy allows, which settles on-chain, and a $0.005 call the policy
   refuses before any money moves;
6. prints an MCP config and an SDK snippet that use the same agent.

Running it again reuses `rein-agent.json`. `--force` creates a new sandbox instead.

## Options

| Option | Default |
|---|---|
| `--engine <url>` | `https://engine.reinconsole.com` (or `$REIN_ENGINE_URL`) |
| `--vendor <url>` | `https://vendor.reinconsole.com` |
| `--force` | reuse an existing `rein-agent.json` |
| `--no-demo` | write the file and stop |
| `--claim` | keep the sandbox: sign in with GitHub or an Ethereum wallet |
| `--mainnet` | move a claimed org's agent to Base mainnet |
| `--approve <decisionId>`, `--reject <decisionId>` | answer an escalation; add `--yes` to sign |

## Keeping the sandbox, and going to mainnet

```
npx @reinconsole/init --claim
```

This asks the engine for a one-time code using the key in `rein-agent.json`, then opens
`app.reinconsole.com/claim` in your browser. Sign in there with GitHub or an Ethereum wallet. Only the
code goes in the link, never the key. Once claimed, the org's keys stop expiring, the sandbox limits
no longer apply, and the console shows your own org when you sign in.

```
npx @reinconsole/init --mainnet
```

This works only on a claimed org. It:

1. writes your **owner file**, `~/.rein/owner-<orgId>.json` (mode 0600). The file holds the org admin
   key and a new approver key. The admin key can change the policy, and the approver key signs
   approvals;
2. registers the public half of the approver key with the engine;
3. replaces the key in `rein-agent.json` with one that can only spend and read for this agent;
4. switches `rein-agent.json` to `network: base`.

Your agent reads `rein-agent.json`, so it can no longer change its own policy or approve its own
escalations. Keep the owner file somewhere your agent cannot read, and back it up: it is the only
copy. The wallet stays the same. Fund it by sending USDC on Base to its address. The starter policy
still applies, now in real USDC: at most $0.004 per call and $0.05 per 24 hours.

The hosted engine does not know which network a payment is on, because a payment intent names `base`
on both. So `--mainnet` enforces the claimed-org rule in the client, backed by the engine's 7-day
expiry on every key an unclaimed sandbox holds.

```
npx @reinconsole/init --approve <decisionId>         # shows the payment
npx @reinconsole/init --approve <decisionId> --yes   # signs and submits
```

An escalation is a payment your policy parks for a person. Approving it means signing the engine's
record of the payment with the approver key, not clicking a link.

## Using the agent from MCP

Point `@reinconsole/mcp` at the file, so the keys stay in one place and never appear in your harness
config:

```json
{
  "mcpServers": {
    "rein": {
      "command": "npx",
      "args": ["-y", "@reinconsole/mcp"],
      "env": { "REIN_AGENT_FILE": "/absolute/path/to/rein-agent.json" }
    }
  }
}
```

## Limits

A sandbox is testnet only and expires after 7 days unless you claim it. It holds at most 3 agents. The hosted engine
also limits how many sandboxes one address, and everyone together, can create per day. To keep
running without limits, self-host the engine: https://reinconsole.com/run-rein-locally

MIT licensed.
