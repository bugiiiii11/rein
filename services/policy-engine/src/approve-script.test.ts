import { spawn } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it } from 'vitest';
import { newId } from '@reinconsole/core';
import { ApprovalService } from './approvals.js';
import { PolicyEngine } from './engine.js';
import { buildServer } from './server.js';

/**
 * `scripts/approve.mjs` is the signing side of A2 -- the one place a human's
 * private key meets an escalation. It is driven here as a real child process
 * against a real HTTP engine, because the thing worth pinning is the whole
 * path: fetch the request, refuse to sign what has not been read, sign with
 * the engine's own canonical form, and land a follow-up decision on the chain.
 * A unit test of the pieces would pass with the wiring between them wrong.
 *
 * The script resolves `@reinconsole/policy-engine` through the repo root's
 * devDependencies, so this suite also fails the day that link is dropped --
 * which is the failure the script would otherwise have on an operator's box.
 */

const SCRIPT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../scripts/approve.mjs',
);

interface Run {
  code: number | null;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

// Each case spawns one to three node processes that import the built engine,
// which is 1-2s apiece on a slow box; the default 5s budget is not enough.
describe('scripts/approve.mjs', { timeout: 60_000 }, () => {
  const approvals = new ApprovalService();
  const engine = new PolicyEngine({ approvals });
  const app = buildServer(engine);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  let approverKeyId = '';
  let baseUrl = '';

  beforeEach(async () => {
    if (baseUrl) return;
    await engine.addPolicy({
      policyId: 'pol_review',
      rules: [{ id: 'big-ticket', escalate: { amountGt: '10.00' } }],
      default: 'allow',
    });
    const approver = await approvals.registerApprover({
      orgId: newId('org'),
      name: 'Finance',
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    });
    approverKeyId = approver.id;
    await app.listen({ port: 0, host: '127.0.0.1' });
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  });

  // The server is closed by the last case; vitest runs a file's cases in order.

  async function escalate(amount = '50.00') {
    const { approval } = await engine.evaluateIntent({
      agentId: newId('agt'),
      vendor: { host: 'api.example.com', address: '0x1' },
      resource: '/v1/answer',
      amount,
      asset: 'USDC',
      chain: 'base',
    });
    if (!approval) throw new Error('expected an escalation');
    return approval.decisionId;
  }

  function env(extra: Record<string, string> = {}): Record<string, string> {
    return {
      REIN_ENGINE_URL: baseUrl,
      REIN_APPROVER_KEY_ID: approverKeyId,
      REIN_APPROVER_PRIVATE_KEY: pem.replace(/\n/g, '\\n'),
      ...extra,
    };
  }

  it('shows the request and stops without --yes, signing nothing', async () => {
    const decisionId = await escalate();
    const r = await run([decisionId, 'approve'], env());
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    // The engine's own record, not a Telegram paraphrase.
    expect(r.stdout).toContain('50.00 USDC on base');
    expect(r.stdout).toContain('api.example.com/v1/answer');
    expect(r.stdout).toContain('re-run with --yes');
    expect(approvals.get(decisionId)?.status).toBe('pending');
    expect(engine.decisions()).toHaveLength(1);
  });

  it('signs with --yes and lands the follow-up decision on the chain', async () => {
    const decisionId = await escalate();
    const before = engine.decisions().length;
    const r = await run([decisionId, 'approve', '--yes'], env());
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('approved: request is now approved');

    const request = approvals.get(decisionId);
    expect(request?.status).toBe('approved');
    expect(request?.approverKeyId).toBe(approverKeyId);
    const chain = engine.decisions();
    expect(chain).toHaveLength(before + 1);
    expect(chain[chain.length - 1]?.outcome).toBe('allow');
    expect(request?.finalDecisionId).toBe(chain[chain.length - 1]?.id);
  });

  it('rejects with --yes, and refuses to answer a request that is already resolved', async () => {
    const decisionId = await escalate();
    const rejected = await run([decisionId, 'reject', '--yes'], env());
    expect(rejected.code).toBe(0);
    expect(approvals.get(decisionId)?.status).toBe('rejected');

    // A second answer is a refused run, not a 4xx buried in a success line.
    const again = await run([decisionId, 'approve', '--yes'], env());
    expect(again.code).toBe(1);
    expect(again.stderr).toContain('already rejected');
  });

  it('--dry-run produces a grant the engine accepts, without submitting it', async () => {
    const decisionId = await escalate();
    const r = await run([decisionId, 'approve', '--dry-run'], env());
    expect(r.code).toBe(0);
    expect(approvals.get(decisionId)?.status).toBe('pending');

    const json = r.stdout.slice(r.stdout.indexOf('{'));
    const grant = JSON.parse(json) as Record<string, string>;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${decisionId}/resolve`,
      payload: grant,
    });
    expect(res.statusCode).toBe(200);
    expect(approvals.get(decisionId)?.status).toBe('approved');
  });

  it('fails closed on a bad verdict, an unknown request, and a missing key', async () => {
    const decisionId = await escalate();
    const verdict = await run([decisionId, 'maybe'], env());
    expect(verdict.code).toBe(1);
    expect(verdict.stderr).toContain('verdict must be');

    const unknown = await run([newId('dec'), 'approve'], env());
    expect(unknown.code).toBe(1);
    expect(unknown.stderr).toContain('404');

    const keyless = await run([decisionId, 'approve', '--yes'], {
      ...env(),
      REIN_APPROVER_PRIVATE_KEY: '',
    });
    expect(keyless.code).toBe(1);
    expect(keyless.stderr).toContain('REIN_APPROVER_PRIVATE_KEY_FILE');
    expect(approvals.get(decisionId)?.status).toBe('pending');

    await app.close();
  });
});
