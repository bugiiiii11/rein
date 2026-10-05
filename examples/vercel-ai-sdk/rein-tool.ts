// A Vercel AI SDK tool that pays x402 paywalls -- and asks Rein first.
//
// Every 402 the tool meets becomes a payment intent, the Rein engine checks it
// against your policy (per-call cap, budgets, allow/deny lists, kill switch),
// and only an allowed intent is signed and paid. A denied one never reaches
// the wallet; the model gets the reason back as the tool result.

import { readFileSync } from 'node:fs';
import { tool } from 'ai';
import { z } from 'zod';
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { createX402Payer } from '@reinconsole/x402-rails';

// Written by `npx @reinconsole/init`: engine URL, agent id, API key, wallet.
const agent = JSON.parse(readFileSync(process.env.REIN_AGENT_FILE ?? 'rein-agent.json', 'utf8'));

// Testnet only. Name the networks explicitly: a guard without this list will
// let a testnet agent be allowed to pay a mainnet 402.
const NETWORKS = ['base-sepolia'];

export const guard = createGuard({
  engineUrl: agent.engineUrl,
  agentId: agent.agentId,
  apiKey: agent.apiKey,
  networks: NETWORKS,
  payer: createX402Payer({ privateKey: agent.wallet.privateKey, networks: NETWORKS }),
  taskContext: { purpose: 'vercel-ai-sdk example' },
});

const paidFetch = guard.wrap();

export const fetchPaid = tool({
  description:
    'HTTP GET a URL that may charge a small USDC fee via x402. ' +
    'Payments are checked against a spend policy first; a blocked payment returns the reason.',
  inputSchema: z.object({ url: z.string().url() }),
  execute: async ({ url }) => {
    try {
      const res = await paidFetch(url);
      const paid = res.headers.has('x-payment-response') || res.headers.has('payment-response');
      return { status: res.status, paid, body: (await res.text()).slice(0, 2000) };
    } catch (err) {
      if (err instanceof PaymentBlockedError) {
        // Nothing was signed. Tell the model why, so it can choose another route.
        return {
          blocked: true,
          amount: `${err.intent.amount} ${err.intent.asset}`,
          reason: err.decision.reason ?? err.decision.outcome,
          decisionId: err.decision.id,
        };
      }
      throw err;
    }
  },
});
