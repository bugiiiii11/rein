import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { buildServer, PolicyEngine } from '@reinconsole/policy-engine';
import { AGENT_FILE, runClaim, runInit, type InitChain } from './index.js';

const VENDOR = 'https://vendor.test';
const PRICES: Record<string, string> = {
  '/testnet/v1/ping': '1000', // $0.001
  '/testnet/v1/scores/vendor/api.example.com': '5000', // $0.005
};

/** An x402 vendor on Base Sepolia: 402 without X-PAYMENT, 200 + settlement with it. */
const vendorFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input : input.url);
  const paid = init?.headers ? new Headers(init.headers).get('X-PAYMENT') : null;
  if (!paid) {
    return new Response(
      JSON.stringify({
        x402Version: 1,
        accepts: [
          {
            scheme: 'exact',
            network: 'base-sepolia',
            maxAmountRequired: PRICES[url.pathname] ?? '1000',
            resource: url.toString(),
            payTo: '0x2222222222222222222222222222222222222222',
            asset: 'USDC',
          },
        ],
        error: 'X-PAYMENT header is required',
      }),
      { status: 402, headers: { 'content-type': 'application/json' } },
    );
  }
  return new Response('{"pong":true}', {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'X-PAYMENT-RESPONSE': Buffer.from(
        JSON.stringify({ success: true, transaction: '0xsettled', network: 'base-sepolia' }),
      ).toString('base64'),
    },
  });
};

const routed: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  return url.startsWith(VENDOR) ? vendorFetch(input, init) : fetch(input, init);
};

function chain(balance: bigint): InitChain {
  return {
    generateWallet: () => ({
      address: '0x1111111111111111111111111111111111111111',
      privateKey: `0x${'33'.repeat(32)}`,
    }),
    balanceOf: async () => balance,
    payerFor: () => () => 'signed-payment',
    txUrl: (tx) => `tx:${tx}`,
  };
}

let engineUrl = '';
let close: () => Promise<void>;

beforeAll(async () => {
  const app = buildServer(new PolicyEngine(), { auth: new ApiKeyAuth(), sandbox: {} });
  await app.listen({ port: 0, host: '127.0.0.1' });
  engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  close = () => app.close();
});
afterAll(() => close());

const quiet = () => undefined;

describe('npx @reinconsole/init', () => {
  it('mints a sandbox, writes rein-agent.json, then one settled payment and one denial', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rein-init-'));
    writeFileSync(join(dir, '.gitignore'), 'node_modules');
    const result = await runInit({
      dir,
      engineUrl,
      vendorUrl: VENDOR,
      fetch: routed,
      chain: chain(50_000n),
      log: quiet,
    });
    expect(result.created).toBe(true);
    expect(result.allowed).toBe('settled');
    expect(result.settlementTx).toBe('0xsettled');
    expect(result.denied).toMatch(/per-call-cap/);

    const written = JSON.parse(readFileSync(join(dir, AGENT_FILE), 'utf8'));
    expect(written).toMatchObject({
      engineUrl,
      network: 'base-sepolia',
      wallet: { address: '0x1111111111111111111111111111111111111111' },
    });
    expect(written.apiKey).toMatch(/^rk_/);
    expect(readFileSync(join(dir, '.gitignore'), 'utf8')).toBe(`node_modules\n${AGENT_FILE}\n`);

    // The settlement was reported: the engine's reconciliation shows it settled.
    const recon = await fetch(`${engineUrl}/v1/reconciliation`, {
      headers: { authorization: `Bearer ${written.apiKey}` },
    }).then((r) => r.json() as Promise<{ settled: number; overspent: number }>);
    expect(recon.settled).toBe(1);
    expect(recon.overspent).toBe(0);
  });

  it('decides without paying when the wallet never gets funded', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rein-init-'));
    const result = await runInit({
      dir,
      engineUrl,
      vendorUrl: VENDOR,
      fetch: routed,
      chain: chain(0n),
      balanceWaitMs: 0,
      log: quiet,
    });
    expect(result.allowed).toBe('unpaid');
    expect(result.denied).toMatch(/per-call-cap/);
  });

  it('reuses an existing rein-agent.json instead of minting another sandbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rein-init-'));
    const first = await runInit({ dir, engineUrl, fetch: routed, chain: chain(0n), noDemo: true, log: quiet });
    const second = await runInit({ dir, engineUrl, fetch: routed, chain: chain(0n), noDemo: true, log: quiet });
    expect(second.created).toBe(false);
    expect(second.agent.agentId).toBe(first.agent.agentId);
  });

  it('says why when the engine refuses the sandbox', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rein-init-'));
    const refusing: typeof fetch = async () =>
      new Response(JSON.stringify({ error: 'sandbox_capacity', message: 'try again tomorrow' }), {
        status: 503,
      });
    await expect(
      runInit({ dir, engineUrl, fetch: refusing, chain: chain(0n), log: quiet }),
    ).rejects.toThrow('(HTTP 503): try again tomorrow');
  });
});

describe('init --claim', () => {
  it('asks the engine for a code with the file key and opens the console on it', async () => {
    const auth = new ApiKeyAuth();
    const app = buildServer(new PolicyEngine(), { auth, sandbox: {} });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const engineUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    try {
      const sb = await (await fetch(`${engineUrl}/v1/sandbox`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json() as { orgId: string; agentId: string; apiKey: string };
      const dir = mkdtempSync(join(tmpdir(), 'rein-claim-'));
      writeFileSync(join(dir, AGENT_FILE), JSON.stringify({ engineUrl, orgId: sb.orgId, agentId: sb.agentId, apiKey: sb.apiKey }));
      const opened: string[] = [];
      const out = await runClaim({ dir, consoleUrl: 'https://console.test', open: (u) => (opened.push(u), true), log: () => undefined });
      expect(out.orgId).toBe(sb.orgId);
      expect(opened).toEqual([out.url]);
      expect(out.url).toMatch(/^https:\/\/console\.test\/claim\?code=[\w-]+$/);
      expect(out.url).not.toContain(sb.apiKey);
    } finally {
      await app.close();
    }
  });

  it('says what to do when there is no rein-agent.json', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rein-claim-'));
    await expect(runClaim({ dir, open: () => true, log: () => undefined })).rejects.toThrow(/run `npx @reinconsole\/init` first/);
  });
});
