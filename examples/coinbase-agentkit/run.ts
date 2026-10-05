// Run: npx tsx run.ts
//
// Uses the testnet wallet `npx @reinconsole/init` wrote to rein-agent.json, so
// it runs with no CDP account. With CDP, swap ViemWalletProvider for
// CdpEvmWalletProvider -- the Rein action does not change.

import { readFileSync } from 'node:fs';
import { AgentKit, ViemWalletProvider } from '@coinbase/agentkit';
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { reinActionProvider } from './rein-action-provider.js';

// AgentKit 0.10 sends its telemetry without awaiting it, so a non-2xx answer
// from the analytics endpoint becomes an unhandled rejection that kills Node.
// Ignore exactly that; anything else still crashes as usual.
process.on('unhandledRejection', (err) => {
  if (err instanceof Error && err.stack?.includes('sendAnalyticsEvent')) return;
  throw err;
});

const agent = JSON.parse(readFileSync(process.env.REIN_AGENT_FILE ?? 'rein-agent.json', 'utf8'));

const walletProvider = new ViemWalletProvider(
  createWalletClient({
    account: privateKeyToAccount(agent.wallet.privateKey),
    chain: baseSepolia,
    transport: http(),
  }),
);

const agentKit = await AgentKit.from({
  walletProvider,
  actionProviders: [
    reinActionProvider({
      engineUrl: agent.engineUrl,
      agentId: agent.agentId,
      apiKey: agent.apiKey,
      networks: ['base-sepolia'],
    }),
  ],
});

// Hand agentKit to your framework as usual, e.g. getLangChainTools(agentKit)
// from @coinbase/agentkit-langchain. Here we call the action directly.
const paidFetch = agentKit.getActions().find((a) => a.name.endsWith('rein_paid_fetch'))!;

const V = 'https://vendor.reinconsole.com/testnet/v1';
console.log(await paidFetch.invoke({ url: `${V}/ping` })); // $0.001: allowed and paid
console.log(await paidFetch.invoke({ url: `${V}/scores/vendor/api.example.com` })); // $0.005: over the $0.004 cap, blocked
