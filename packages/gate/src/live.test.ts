import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { newId } from '@reinconsole/core';
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import { caip2Of, createGuard, type FetchLike } from '@reinconsole/sdk';
import { BASE_SEPOLIA_USDC, FacilitatorClient, createX402Payer } from '@reinconsole/x402-rails';
import { createGate } from './gate.js';
import { createGatedFetch } from './fetch.js';
import { facilitatorClientRails } from './rails.js';

/**
 * LIVE v2 test against the hosted facilitator at x402.org and Base Sepolia.
 * Gated like services/x402-rails/src/live.test.ts (same env, same wallet):
 *
 *   $env:NODE_EXTRA_CA_CERTS = "$HOME\.rein-dev-ca.pem"; $env:RUN_LIVE = "1"
 *   pnpm --filter @reinconsole/gate test
 *
 * Spends $0.01 of testnet USDC per run.
 */
const KEY = process.env['REIN_SEPOLIA_PRIVATE_KEY'] as Hex | undefined;
const live = Boolean(process.env['RUN_LIVE']) && KEY !== undefined;

describe.skipIf(!live)('live: the full x402 v2 loop on Base Sepolia', () => {
  it(
    'settles a guarded $0.01 payment over the v2 wire (gate + PAYMENT-SIGNATURE)',
    { timeout: 120_000 },
    async () => {
      const engine = new PolicyEngine();
      const app = buildServer(engine);
      await app.listen({ port: 0, host: '127.0.0.1' });
      try {
        const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
        const wallet = privateKeyToAccount(KEY!).address;

        const agentId = newId('agt');
        await engine.registerAgent({
          id: agentId,
          orgId: newId('org'),
          name: 'live-v2-test-agent',
          wallets: [{ chain: 'base', address: wallet, mode: 'sdk' }],
          status: 'active',
          createdAt: new Date(),
        });

        // The vendor side is Rein's own gate on real rails, advertising v2 —
        // this exercises the S19 gate v2 path and the payer path in one live
        // loop: PAYMENT-REQUIRED quote → guard resolves the CAIP-2 offer →
        // EIP-3009 payer → rewrapped PAYMENT-SIGNATURE → gate relays the v2
        // envelope to x402.org → real USDC settlement on Base Sepolia.
        const gate = createGate({
          routes: [
            {
              path: '/v1/live-v2',
              price: '0.01',
              description: 'rein live v2 settle test',
              mimeType: 'application/json',
            },
          ],
          rails: facilitatorClientRails(new FacilitatorClient()),
          payTo: process.env['REIN_SEPOLIA_VENDOR_ADDRESS'] ?? wallet,
          network: 'base-sepolia',
          asset: BASE_SEPOLIA_USDC,
          maxTimeoutSeconds: 300,
          extra: { name: 'USDC', version: '2' },
          advertiseV2: true,
        });
        const vendorFetch = createGatedFetch(gate);
        let paidHeader: string | undefined;
        const spyingFetch: FetchLike = async (input, init) => {
          const headers = init?.headers ? new Headers(init.headers) : new Headers();
          if (headers.get('PAYMENT-SIGNATURE') !== null) paidHeader = 'PAYMENT-SIGNATURE';
          else if (headers.get('X-PAYMENT') !== null) paidHeader = 'X-PAYMENT';
          return vendorFetch(input, init);
        };

        const guard = createGuard({
          engineUrl,
          agentId,
          fetch: spyingFetch,
          payer: createX402Payer({ privateKey: KEY! }),
        });
        await guard.client.addPolicy({
          policyId: 'pol_live_v2',
          appliesTo: { agents: [agentId] },
          rules: [{ id: 'tx-cap', deny: { amountGt: '0.05' } }],
          default: 'allow',
        });

        const res = await guard.wrap()('https://demo.rein.dev/v1/live-v2');

        expect(res.status).toBe(200);
        expect(paidHeader).toBe('PAYMENT-SIGNATURE');
        const receipt = guard.receipts()[0];
        expect(receipt?.outcome).toBe('allow');
        expect(receipt?.settlement?.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
        expect(caip2Of(receipt?.settlement?.networkId ?? '')).toBe('eip155:84532');
        // The gate's own receipt reconciles to the same on-chain settlement.
        expect(gate.receipts[0]?.transaction).toBe(receipt?.settlement?.txHash);
      } finally {
        await app.close();
      }
    },
  );
});
