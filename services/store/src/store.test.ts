import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { newId } from '@rein/core';
import { PolicyEngine, verifyDecisionChain } from '@rein/policy-engine';
import { openReinStore, type ReinStore } from './index.js';

function intent(agentId: string, amount: string) {
  return {
    agentId,
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount,
    asset: 'USDC' as const,
    chain: 'base' as const,
  };
}

const dirs: string[] = [];
const opened: ReinStore[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rein-store-'));
  dirs.push(dir);
  return dir;
}

/** Track every store so afterEach can close stragglers (double-close is fine). */
async function open(dir?: string): Promise<ReinStore> {
  const store = await openReinStore(dir ? { dir } : {});
  opened.push(store);
  return store;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
});

// Data dirs are removed once at the END of the suite: PGlite's emscripten FS
// can flush a moment after close() resolves, and deleting the dir under a
// straggler surfaces as an unhandled ENOENT pinned on the next test.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best-effort: stray temp dirs are harmless
    }
  }
});

describe('openReinStore', () => {
  it('is fresh exactly once per data directory', async () => {
    const dir = tempDir();
    const first = await open(dir);
    expect(first.fresh).toBe(true);
    expect(first.resumedDecisions).toBe(0);
    await first.close();

    const second = await open(dir);
    expect(second.fresh).toBe(false);
  });

  it('runs fully in-memory when no dir is given', async () => {
    const engine = new PolicyEngine(await open());
    await engine.addPolicy({ policyId: 'open', rules: [], default: 'allow' });
    const { decision } = await engine.evaluateIntent(intent(newId('agt'), '0.01'));
    expect(decision.outcome).toBe('allow');
  });

  it('persists agents and the kill switch across restarts', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const engineA = new PolicyEngine(a);
    const agent = await engineA.registerAgent({
      id: newId('agt'),
      orgId: newId('org'),
      name: 'survivor',
      wallets: [{ chain: 'base', address: '0xabc', mode: 'sdk' }],
      status: 'active',
      createdAt: new Date(),
    });
    await engineA.addPolicy({ policyId: 'open', rules: [], default: 'allow' });
    await engineA.freeze(agent.id);
    await a.close();

    const b = await open(dir);
    const engineB = new PolicyEngine(b);
    const loaded = engineB.agents.get(agent.id);
    expect(loaded?.name).toBe('survivor');
    expect(loaded?.wallets).toEqual(agent.wallets);
    expect(loaded?.createdAt).toEqual(agent.createdAt);
    expect(engineB.agents.isFrozen(agent.id)).toBe(true);

    const frozen = await engineB.evaluateIntent(intent(agent.id, '0.01'));
    expect(frozen.decision.outcome).toBe('deny');
    expect(frozen.decision.reason).toContain('kill switch');

    await engineB.unfreeze(agent.id);
    await b.close();

    const c = await open(dir);
    expect(c.agents.isFrozen(agent.id)).toBe(false);
  });

  it('persists policy evaluation order, including upsert-moves-to-end', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const engineA = new PolicyEngine(a);
    await engineA.addPolicy({ policyId: 'p1', version: '1', rules: [], default: 'deny' });
    await engineA.addPolicy({ policyId: 'p2', version: '1', rules: [], default: 'allow' });
    // Updating p1 re-files it AFTER p2 (first-applicable-wins order).
    await engineA.addPolicy({ policyId: 'p1', version: '2', rules: [], default: 'allow' });
    expect(engineA.policies.list().map((p) => p.policyId)).toEqual(['p2', 'p1']);
    await a.close();

    const b = await open(dir);
    expect(b.policies.list().map((p) => p.policyId)).toEqual(['p2', 'p1']);
    expect(b.policies.get('p1')?.version).toBe('2');
  });

  it('continues the decision chain across restarts, verifiable under one key', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const engineA = new PolicyEngine(a);
    await engineA.addPolicy({
      policyId: 'cap',
      rules: [{ id: 'hard-cap', deny: { amountGt: '5.00' } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    await engineA.evaluateIntent(intent(agentId, '1.00'));
    await engineA.evaluateIntent(intent(agentId, '6.00'));
    const keyPem = a.publicKeyPem;
    await a.close();

    const b = await open(dir);
    expect(b.resumedDecisions).toBe(2);
    expect(b.publicKeyPem).toBe(keyPem);

    const engineB = new PolicyEngine(b);
    await engineB.evaluateIntent(intent(agentId, '2.00'));

    const all = engineB.decisions();
    expect(all).toHaveLength(3);
    expect(all[2]!.prevHash).toBe(all[1]!.hash);
    // The whole chain — two pre-restart entries included — verifies against
    // the persisted key: restart left no seam.
    expect(verifyDecisionChain(all, b.publicKeyPem)).toBe(true);
    expect(all.map((d) => d.outcome)).toEqual(['allow', 'deny', 'allow']);
  });

  it('rolling budgets remember spend from before the restart', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const engineA = new PolicyEngine(a);
    await engineA.addPolicy({
      policyId: 'budget',
      rules: [{ id: 'daily', deny: { rollingSum: { window: '24h', gt: '1.00' } } }],
      default: 'allow',
    });
    const agentId = newId('agt');
    const first = await engineA.evaluateIntent(intent(agentId, '0.60'));
    expect(first.decision.outcome).toBe('allow');
    await a.close();

    // Same agent, new process: 0.60 prior + 0.60 now = 1.20 > 1.00.
    const engineB = new PolicyEngine(await open(dir));
    const second = await engineB.evaluateIntent(intent(agentId, '0.60'));
    expect(second.decision.outcome).toBe('deny');
    expect(second.decision.reason).toContain('daily');
  });

  it('persists vendor reputation', async () => {
    const dir = tempDir();
    const a = await open(dir);
    await a.spend.setVendorReputation('sketchy.example', 12);
    await a.close();

    const b = await open(dir);
    expect(b.spend.contextFor(newId('agt')).vendorReputation('sketchy.example')).toBe(12);
  });
});
