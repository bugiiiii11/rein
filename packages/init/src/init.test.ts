import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { ApprovalService, buildServer, PolicyEngine } from '@reinconsole/policy-engine';
import {
  AGENT_FILE,
  ownerFilePath,
  runApprove,
  runClaim,
  runInit,
  runMainnet,
  type InitChain,
} from './index.js';

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
      const out = await runClaim({ dir, consoleUrl: 'https://console.test', open: (u) => (opened.push(u), true), log: () => undefined, waitMs: 0 });
      expect(out.claimed).toBe(false);
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
    await expect(runClaim({ dir, open: () => true, log: () => undefined, waitMs: 0 })).rejects.toThrow(/run `npx @reinconsole\/init` first/);
  });
});

describe('init --mainnet and --approve', () => {
  let url = '';
  let stop: () => Promise<void>;
  let identityKey = '';

  beforeAll(async () => {
    const auth = new ApiKeyAuth();
    const app = buildServer(new PolicyEngine({ approvals: new ApprovalService({ ttlMs: 60_000 }) }), {
      auth,
      // Six sandboxes from one address in this file: over the default per-IP day cap.
      sandbox: { perIpPerDay: 20 },
      // With the sandbox on, the default lets NO org onto mainnet (the hosted
      // engine's legal posture, S95); the gate itself is tested in the engine.
      mainnetOrgs: 'any',
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    stop = () => app.close();
    // What the console holds: an UNSCOPED key that may say who signed in.
    identityKey = (await auth.issue({ name: 'console-identity', scopes: ['identity'] })).secret;
  });
  afterAll(() => stop());

  const call = async (method: string, path: string, key: string, body?: unknown) => {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };

  async function sandbox() {
    const dir = mkdtempSync(join(tmpdir(), 'rein-mainnet-'));
    const ownerDir = mkdtempSync(join(tmpdir(), 'rein-owner-'));
    const { agent } = await runInit({ dir, engineUrl: url, chain: chain(0n), noDemo: true, log: quiet });
    return { dir, ownerDir, agent };
  }

  async function claimed(identity: string) {
    const box = await sandbox();
    const { url: link } = await runClaim({ dir: box.dir, open: () => true, log: quiet, waitMs: 0 });
    const code = new URL(link).searchParams.get('code');
    const redeemed = await call('POST', '/v1/claims/redeem', identityKey, { code, identity });
    expect(redeemed.status).toBe(200);
    return box;
  }

  it('--claim waits for the sign-in and says so', async () => {
    const box = await sandbox();
    const lines: string[] = [];
    const waiting = runClaim({ dir: box.dir, open: () => true, log: (l) => lines.push(l), waitMs: 20_000, pollMs: 50 });
    // The link is printed before the wait begins; redeem it meanwhile.
    while (!lines.some((l) => l.includes('/claim?code='))) await new Promise((r) => setTimeout(r, 10));
    const code = new URL(lines.find((l) => l.includes('/claim?code='))!.trim()).searchParams.get('code');
    expect((await call('POST', '/v1/claims/redeem', identityKey, { code, identity: 'github:777' })).status).toBe(200);
    const out = await waiting;
    expect(out.claimed).toBe(true);
    expect(lines.join('\n')).toMatch(/Claimed: org org_\w+ is yours \(signed in as github:777\)/);
  });

  it('refuses an org nobody has claimed, and writes nothing', async () => {
    const { dir, ownerDir, agent } = await sandbox();
    await expect(runMainnet({ dir, ownerDir, log: quiet })).rejects.toThrow(/needs a claimed org/);
    expect(existsSync(ownerFilePath(agent.orgId, ownerDir))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, AGENT_FILE), 'utf8')).network).toBe('base-sepolia');
  });

  it('moves a claimed org to mainnet: owner keys out of the agent file, a narrowed key in', async () => {
    const { dir, ownerDir, agent } = await claimed('github:101');
    const result = await runMainnet({ dir, ownerDir, log: quiet });
    expect(result.changed).toBe(true);

    const written = JSON.parse(readFileSync(join(dir, AGENT_FILE), 'utf8'));
    expect(written.network).toBe('base');
    expect(written.expiresAt).toBeUndefined();
    expect(written.wallet).toEqual(agent.wallet);
    expect(written.apiKey).not.toBe(agent.apiKey);

    const owner = JSON.parse(readFileSync(result.ownerFile, 'utf8'));
    expect(owner.adminKey).toBe(agent.apiKey);
    expect(owner.approver.privateKeyPem).toMatch(/BEGIN PRIVATE KEY/);
    const approvers = await call('GET', '/v1/approvers', owner.adminKey);
    expect(approvers.body.map((a: { id: string }) => a.id)).toEqual([owner.approver.keyId]);

    // The agent's new key spends and reads for this agent only: no policy
    // writes, no keys, no approvals.
    const runtime = (await call('GET', '/v1/keys', owner.adminKey)).body.find(
      (k: { name: string }) => k.name === 'mainnet-runtime',
    );
    expect(runtime).toMatchObject({ scopes: ['evaluate', 'read'], agentIds: [agent.agentId] });
    expect(runtime.expiresAt).toBeUndefined();
    const policy = { policyId: 'pol_loosen', appliesTo: { agents: [agent.agentId] }, rules: [], default: 'allow' };
    expect((await call('POST', '/v1/policies', written.apiKey, policy)).status).toBe(403);
    expect((await call('POST', '/v1/keys', written.apiKey, { name: 'x', scopes: ['admin'], agentIds: [agent.agentId] })).status).toBe(403);

    // Idempotent, and the testnet demo will not run against a mainnet file.
    expect((await runMainnet({ dir, ownerDir, log: quiet })).changed).toBe(false);
    expect((await runInit({ dir, engineUrl: url, chain: chain(0n), log: quiet })).allowed).toBeUndefined();
    await expect(runInit({ dir, engineUrl: url, chain: chain(0n), force: true, log: quiet })).rejects.toThrow(
      /wallet's only key/,
    );
  });

  it('resumes with the approver key an interrupted run already wrote', async () => {
    const { dir, ownerDir, agent } = await claimed('github:102');
    const failOnce: typeof fetch = async (input, init) => {
      const target = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (target.endsWith('/v1/keys') && init?.method === 'POST') return new Response('{"error":"boom"}', { status: 503 });
      return fetch(input, init);
    };
    await expect(runMainnet({ dir, ownerDir, fetch: failOnce, log: quiet })).rejects.toThrow(/runtime key \(HTTP 503\)/);
    const first = JSON.parse(readFileSync(ownerFilePath(agent.orgId, ownerDir), 'utf8'));
    expect(first.approver.keyId).toMatch(/^apk_/);

    await runMainnet({ dir, ownerDir, log: quiet });
    const second = JSON.parse(readFileSync(ownerFilePath(agent.orgId, ownerDir), 'utf8'));
    expect(second.approver).toEqual(first.approver);
    expect((await call('GET', '/v1/approvers', first.adminKey)).body).toHaveLength(1);
  });

  it('answers an escalation with the approver key, only after --yes', async () => {
    const { dir, ownerDir, agent } = await claimed('eth:0x00000000000000000000000000000000000000a1');
    await runMainnet({ dir, ownerDir, log: quiet });
    const owner = JSON.parse(readFileSync(ownerFilePath(agent.orgId, ownerDir), 'utf8'));
    // The owner adds a review rule to the org's policy -- with the owner's key.
    const [starter] = (await call('GET', '/v1/policies', owner.adminKey)).body;
    const review = { ...starter, rules: [...starter.rules, { id: 'review', escalate: { amountGt: '0.002' } }] };
    expect((await call('POST', '/v1/policies', owner.adminKey, review)).status).toBe(200);
    const runtimeKey = JSON.parse(readFileSync(join(dir, AGENT_FILE), 'utf8')).apiKey;
    const parked = await call('POST', '/v1/evaluate', runtimeKey, {
      agentId: agent.agentId,
      vendor: { host: 'api.vendor.com', address: '0xabc' },
      resource: '/v1/search',
      amount: '0.003',
      asset: 'USDC',
      chain: 'base',
    });
    expect(parked.body.decision.outcome).toBe('escalate');
    const decisionId = parked.body.decision.id;

    const lines: string[] = [];
    const shown = await runApprove({ dir, ownerDir, decisionId, verdict: 'approve', log: (l) => lines.push(l) });
    expect(shown).toEqual({ status: 'pending', signed: false });
    expect(lines.join('\n')).toMatch(/0\.003 USDC on base/);

    const done = await runApprove({ dir, ownerDir, decisionId, verdict: 'approve', yes: true, log: quiet });
    expect(done).toEqual({ status: 'approved', signed: true });
    await expect(runApprove({ dir, ownerDir, decisionId, verdict: 'approve', yes: true, log: quiet })).rejects.toThrow(
      /already approved/,
    );
  });

  it('says where the approver comes from when there is no owner file', async () => {
    const { dir, ownerDir } = await sandbox();
    await expect(runApprove({ dir, ownerDir, decisionId: 'dec_x', verdict: 'reject', log: quiet })).rejects.toThrow(
      /--mainnet` registers the approver/,
    );
  });
});
