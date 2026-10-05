# Spend limits for your x402 agent: Vercel AI SDK

A Vercel AI SDK `tool()` that pays x402 paywalls, with every payment checked against a Rein policy before anything is signed. A denied payment never reaches the wallet. The model gets the reason back as the tool result and can pick another route.

Testnet only (Base Sepolia). No account needed.

## Run it

```bash
npm install
npx @reinconsole/init        # creates a sandbox agent, a funded test wallet and rein-agent.json
ANTHROPIC_API_KEY=... npm start
```

`init` gives the sandbox a starter policy: a $0.004 per-call cap on Base Sepolia. The agent is asked to call two paid endpoints:

| Endpoint | Price | Result |
|---|---|---|
| `/testnet/v1/ping` | $0.001 | allowed, paid on Base Sepolia |
| `/testnet/v1/scores/vendor/api.example.com` | $0.005 | blocked: `denied by: per-call-cap`, nothing signed |

## Use it in your agent

[`rein-tool.ts`](rein-tool.ts) is the whole integration. Copy it and add `fetchPaid` to your `tools`:

```ts
import { generateText, isStepCount } from 'ai';
import { fetchPaid } from './rein-tool.js';

await generateText({ model, tools: { fetchPaid }, stopWhen: isStepCount(5), prompt });
```

Your policy lives on the engine, not in the code: change the cap, add budgets or a deny list, or freeze the agent, and the tool obeys on the next call. Read it with `GET <engineUrl>/v1/policies`, using the API key in `rein-agent.json`.

## Notes

- **Name your networks.** The guard and payer both take `networks: ['base-sepolia']`. Without the list, a testnet agent could be allowed to pay a mainnet 402.
- **Receipts.** `guard.receipts()` lists every paywall the agent met, allowed or not. Use `onReceipt` in `createGuard` to stream them out.
- **SDK mode is advisory.** An agent that holds its own key can route around the guard, and the indexer flags that as shadow spend. See the [Rein README](../../README.md).
- Keep `rein-agent.json` private. It holds the wallet key and the API key.
