import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { newId } from '@reinconsole/core';
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import { createGuard } from '@reinconsole/sdk';
import { FacilitatorClient } from './facilitator.js';
import { createX402Payer } from './payer.js';
import { createRealVendor } from './vendor.js';

/**
 * LIVE tests against the hosted facilitator at x402.org and Base Sepolia.
 * Gated: they need network, a funded wallet (Circle faucet USDC), and —
 * on this machine — NODE_EXTRA_CA_CERTS pointing at the local CA pem.
 *
 *   $env:NODE_EXTRA_CA_CERTS = "$HOME\.rein-dev-ca.pem"; $env:RUN_LIVE = "1"
 *   pnpm --filter @reinconsole/x402-rails test
 *
 * The settlement test spends $0.01 of testnet USDC per run.
 */
const KEY = process.env['REIN_SEPOLIA_PRIVATE_KEY'] as Hex | undefined;
const live = Boolean(process.env['RUN_LIVE']) && KEY !== undefined;

describe.skipIf(!live)('live: hosted facilitator on Base Sepolia', () => {
  it('advertises v1 exact on base-sepolia via /supported', { timeout: 30_000 }, async () => {
    const kinds = (await new FacilitatorClient().supported()) as {
      kinds?: { x402Version?: number; scheme?: string; network?: string }[];
    };
    expect(kinds.kinds).toBeDefined();
    expect(
      kinds.kinds!.some(
        (k) => k.x402Version === 1 && k.scheme === 'exact' && k.network === 'base-sepolia',
      ),
    ).toBe(true);
  });

  it('settles a guarded $0.01 payment on-chain', { timeout: 120_000 }, async () => {
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
        name: 'live-test-agent',
        wallets: [{ chain: 'base', address: wallet, mode: 'sdk' }],
        status: 'active',
        createdAt: new Date(),
      });

      const vendor = createRealVendor({
        facilitator: new FacilitatorClient(),
        atomicPrice: '10000',
        payTo: process.env['REIN_SEPOLIA_VENDOR_ADDRESS'] ?? wallet,
      });
      const guard = createGuard({
        engineUrl,
        agentId,
        fetch: vendor.fetch,
        payer: createX402Payer({ privateKey: KEY! }),
      });
      await guard.client.addPolicy({
        policyId: 'pol_live',
        appliesTo: { agents: [agentId] },
        rules: [{ id: 'tx-cap', deny: { amountGt: '0.05' } }],
        default: 'allow',
      });

      const res = await guard.wrap()('https://demo.rein.dev/v1/live-test');

      expect(res.status).toBe(200);
      const receipt = guard.receipts()[0];
      expect(receipt?.outcome).toBe('allow');
      expect(receipt?.settlement?.txHash).toMatch(/^0x[0-9a-fA-F]{64}$/);
      expect(receipt?.settlement?.networkId).toBe('base-sepolia');
    } finally {
      await app.close();
    }
  });
});
