// A Coinbase AgentKit action that pays x402 paywalls with the AgentKit wallet --
// and asks Rein first.
//
// Rein never holds the key: the payment is signed by AgentKit's own wallet
// provider, but only after the Rein engine has allowed the
// intent against your policy. A denied intent is never signed.
//
// Register THIS instead of AgentKit's built-in `x402ActionProvider`, not next
// to it: the built-in one pays without asking, and an agent offered both can
// route around the policy.

import { customActionProvider, type EvmWalletProvider } from '@coinbase/agentkit';
import { z } from 'zod';
import { createGuard, PaymentBlockedError } from '@reinconsole/sdk';
import { createX402Payer } from '@reinconsole/x402-rails';

export interface ReinOptions {
  engineUrl: string;
  agentId: string;
  apiKey: string;
  /** x402 network ids the agent may pay on, e.g. ['base-sepolia']. */
  networks: string[];
}

export function reinActionProvider(rein: ReinOptions) {
  // One governed fetch per wallet provider, built on first use.
  const fetches = new WeakMap<EvmWalletProvider, typeof fetch>();
  const paidFetchFor = (wallet: EvmWalletProvider) => {
    let paidFetch = fetches.get(wallet);
    if (!paidFetch) {
      paidFetch = createGuard({
        engineUrl: rein.engineUrl,
        agentId: rein.agentId,
        apiKey: rein.apiKey,
        networks: rein.networks,
        // Any AgentKit EVM wallet (Viem, CDP, Privy) signs the x402 authorization.
        payer: createX402Payer({
          account: {
            address: wallet.getAddress() as `0x${string}`,
            signTypedData: (typedData: unknown) => wallet.signTypedData(typedData),
          },
          networks: rein.networks,
        }),
        taskContext: { purpose: 'agentkit example' },
      }).wrap();
      fetches.set(wallet, paidFetch);
    }
    return paidFetch;
  };

  return customActionProvider<EvmWalletProvider>({
    name: 'rein_paid_fetch',
    description:
      'HTTP GET a URL that may charge a small USDC fee via x402. ' +
      'Payments are checked against a spend policy first; a blocked payment returns the reason.',
    schema: z.object({ url: z.string().url() }),
    invoke: async (wallet: EvmWalletProvider, { url }: { url: string }) => {
      try {
        const res = await paidFetchFor(wallet)(url);
        const paid = res.headers.has('x-payment-response') || res.headers.has('payment-response');
        return JSON.stringify({ status: res.status, paid, body: (await res.text()).slice(0, 2000) });
      } catch (err) {
        if (err instanceof PaymentBlockedError) {
          // Nothing was signed. Tell the model why, so it can choose another route.
          return JSON.stringify({
            blocked: true,
            amount: `${err.intent.amount} ${err.intent.asset}`,
            reason: err.decision.reason ?? err.decision.outcome,
            decisionId: err.decision.id,
          });
        }
        throw err;
      }
    },
  });
}
