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

A sandbox is testnet only and expires after 7 days. It holds at most 3 agents. The hosted engine
also limits how many sandboxes one address, and everyone together, can create per day. To keep
running without limits, self-host the engine: https://reinconsole.com/run-rein-locally

MIT licensed.
