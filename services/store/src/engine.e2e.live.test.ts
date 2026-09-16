/**
 * The engine e2e on REAL rails: the deployable bin governs a $0.01 USDC
 * settlement on Base Sepolia through the hosted x402.org facilitator. Same
 * loop as `engine.e2e.test.ts`, same gating as the other live suites:
 *
 *   $env:NODE_EXTRA_CA_CERTS = "$HOME\.rein-dev-ca.pem"; $env:RUN_LIVE = "1"
 *   pnpm --filter @reinconsole/store test -- engine.e2e.live
 *
 * `REIN_SEPOLIA_PRIVATE_KEY` must be in the process env (vitest does not load
 * `.env`). Spends $0.01 of testnet USDC per run.
 */
import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { newId } from '@reinconsole/core';
import { createGate, createGatedFetch, facilitatorClientRails } from '@reinconsole/gate';
import { EngineClient, createGuard } from '@reinconsole/sdk';
import { BASE_SEPOLIA_USDC, FacilitatorClient, createX402Payer } from '@reinconsole/x402-rails';
import { engineUnderTest, until } from './engine-e2e.js';

const KEY = process.env['REIN_SEPOLIA_PRIVATE_KEY'] as Hex | undefined;
const live = Boolean(process.env['RUN_LIVE']) && KEY !== undefined;

describe.skipIf(!live)('live: the deployable engine governs a real Base Sepolia settlement', () => {
  it(
    'allow -> pay $0.01 on real rails -> settle -> reconciled',
    { timeout: 180_000 },
    async () => {
      const engine = await engineUnderTest();
      try {
        const wallet = privateKeyToAccount(KEY!).address;
        const admin = new EngineClient({ baseUrl: engine.url, apiKey: engine.adminSecret });
        const agent = await admin.registerAgent({
          orgId: newId('org'),
          name: 'e2e-live-agent',
          wallets: [{ chain: 'base', address: wallet, mode: 'sdk' }],
        });
        await admin.addPolicy({
          policyId: newId('pol'),
          appliesTo: { agents: [agent.id] },
          rules: [{ id: 'tx-cap', deny: { amountGt: '0.05' } }],
          default: 'allow',
        });
        const agentSecret = (
          await admin.issueApiKey({ name: 'e2e-live-agent', scopes: ['read', 'evaluate'] })
        ).secret;

        // The vendor is Rein's own gate on the real facilitator, advertising
        // v2 -- the same composition `packages/gate/src/live.test.ts` proved.
        const vendorFetch = createGatedFetch(
          createGate({
            routes: [{ path: '/v1/live-e2e', price: '0.01', description: 'rein engine e2e' }],
            rails: facilitatorClientRails(new FacilitatorClient()),
            payTo: process.env['REIN_SEPOLIA_VENDOR_ADDRESS'] ?? wallet,
            network: 'base-sepolia',
            asset: BASE_SEPOLIA_USDC,
            maxTimeoutSeconds: 300,
            extra: { name: 'USDC', version: '2' },
            advertiseV2: true,
          }),
        );
        const guard = createGuard({
          engineUrl: engine.url,
          apiKey: agentSecret,
          agentId: agent.id,
          fetch: vendorFetch,
          payer: createX402Payer({ privateKey: KEY! }),
        });

        const res = await guard.wrap()('https://vendor.e2e.test/v1/live-e2e');
        expect(res.status).toBe(200);
        const receipt = guard.receipts().at(-1)!;
        expect(receipt.outcome).toBe('allow');
        expect(receipt.settlement?.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);

        const report = await until(
          () => guard.client.reconciliation({ window: '1h', graceMs: 0, agentId: agent.id }),
          (r) => r.settled === 1 && r.unsettled === 0,
          30_000,
        );
        expect(report).toMatchObject({ allowed: 1, settled: 1, unsettled: 0 });
      } finally {
        await engine.dispose();
      }
    },
  );
});
