# Spend limits for your x402 agent: Coinbase AgentKit

An AgentKit action that pays x402 paywalls with the AgentKit wallet, after Rein has checked each payment against your policy. Rein never holds the key. The wallet provider signs, and only once the engine has allowed the payment. A denied payment is never signed.

Testnet only (Base Sepolia). No account needed: no CDP and no Rein signup.

## Run it

```bash
npm install
npx @reinconsole/init        # creates a sandbox agent, a funded test wallet and rein-agent.json
npm start
```

`run.ts` builds a `ViemWalletProvider` from the test wallet in `rein-agent.json` and calls the action twice:

| Endpoint | Price | Result |
|---|---|---|
| `/testnet/v1/ping` | $0.001 | allowed, paid on Base Sepolia |
| `/testnet/v1/scores/vendor/api.example.com` | $0.005 | blocked: `denied by: per-call-cap`, nothing signed |

## Use it in your agent

[`rein-action-provider.ts`](rein-action-provider.ts) is the whole integration:

```ts
const agentKit = await AgentKit.from({
  walletProvider,                       // Viem, CDP, Privy -- any EVM wallet provider
  actionProviders: [
    reinActionProvider({ engineUrl, agentId, apiKey, networks: ['base-sepolia'] }),
    // ...your other providers, but NOT x402ActionProvider (see below)
  ],
});
const tools = await getLangChainTools(agentKit);   // or your framework's adapter
```

**Register it instead of AgentKit's built-in `x402ActionProvider`, not alongside it.** The built-in action pays without asking. An agent offered both can route around the policy.

## Notes

- **viem is pinned to `2.38.3`**, the exact version AgentKit 0.10 pins. Rein's packages bring their own newer viem. The action signs through the wallet provider's own `signTypedData`, so the two copies never meet.
- **AgentKit telemetry can crash Node.** AgentKit 0.10 sends usage analytics without awaiting them, so a non-2xx answer from its endpoint is an unhandled rejection. `run.ts` ignores exactly that error; copy the handler if you see `sendAnalyticsEvent` in a crash.
- **Cold start is slow.** AgentKit's dependency tree is large, so the first import can take a minute or more.
- **Name your networks.** Without `networks`, a testnet agent could be allowed to pay a mainnet 402.
- **Your policy lives on the engine.** Change the cap, add budgets or a deny list, or freeze the agent, and the action obeys on the next call.
- Keep `rein-agent.json` private. It holds the wallet key and the API key.
