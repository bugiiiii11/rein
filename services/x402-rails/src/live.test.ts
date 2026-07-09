import { describe, it, expect } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { newId, type Decision, type PaymentIntent } from '@reinconsole/core';
import { PolicyEngine, buildServer } from '@reinconsole/policy-engine';
import { PaymentRequirement, createGuard, v2Requirements, wrapPaymentV2 } from '@reinconsole/sdk';
import { FacilitatorClient } from './facilitator.js';
import { createX402Payer } from './payer.js';
import { createRealVendor } from './vendor.js';
import { BASE_SEPOLIA_USDC } from './wallet.js';

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

  it('advertises v2 exact on eip155:84532 via /supported', { timeout: 30_000 }, async () => {
    const kinds = (await new FacilitatorClient().supported()) as {
      kinds?: { x402Version?: number; scheme?: string; network?: string }[];
    };
    expect(
      kinds.kinds!.some(
        (k) => k.x402Version === 2 && k.scheme === 'exact' && k.network === 'eip155:84532',
      ),
    ).toBe(true);
  });

  it('the facilitator verifies a rewrapped v2 envelope (no settle)', { timeout: 30_000 }, async () => {
    const wallet = privateKeyToAccount(KEY!).address;
    const requirement = PaymentRequirement.parse({
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: '10000',
      resource: 'https://demo.rein.dev/v1/live-v2-verify',
      description: 'rein v2 verify probe',
      mimeType: 'application/json',
      payTo: process.env['REIN_SEPOLIA_VENDOR_ADDRESS'] ?? wallet,
      maxTimeoutSeconds: 300,
      asset: BASE_SEPOLIA_USDC,
      extra: { name: 'USDC', version: '2' },
    });
    // The payer only reads the intent id (the EIP-3009 nonce derivation).
    const v1Header = await createX402Payer({ privateKey: KEY! })(
      requirement,
      { id: newId('int') } as PaymentIntent,
      undefined as unknown as Decision,
    );
    const envelope = JSON.parse(
      Buffer.from(wrapPaymentV2(v1Header, requirement), 'base64').toString('utf8'),
    ) as { x402Version: number } & Record<string, unknown>;

    const verified = await new FacilitatorClient().verify(envelope, v2Requirements(requirement));

    expect(verified.isValid).toBe(true);
  });

  // The live v2 SETTLE test (guard → gate → x402.org) lives in
  // packages/gate/src/live.test.ts — the gate cannot be imported from here
  // without a workspace dependency cycle (gate devDepends on these rails).
});
