import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { newId } from '@reinconsole/core';
import { generateKeyPairSync } from 'node:crypto';
import {
  ApprovalService,
  LivenessMonitor,
  PolicyEngine,
  signApproval,
  verifyDecisionChain,
} from '@reinconsole/policy-engine';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { loadOrCreateKeyPair, openDb, openReinStore, type ReinStore } from './index.js';

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
async function open(dir?: string, signingKey?: string): Promise<ReinStore> {
  const store = await openReinStore({ ...(dir ? { dir } : {}), ...(signingKey ? { signingKey } : {}) });
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
  it('creates the data directory, parents included', async () => {
    // The deploy shape this guards: a data dir nested more than one level
    // below a mounted volume. PGlite's own mkdir is not recursive, so without
    // this the store throws ENOENT on boot — which under a container restart
    // policy is a crash-loop, not a readable error.
    const nested = join(tempDir(), 'volume', 'rein', 'console');
    const store = await open(nested);
    expect(store.fresh).toBe(true);
    expect(existsSync(nested)).toBe(true);

    // And it is a real database, not just a directory that got made.
    await store.close();
    const resumed = await open(nested);
    expect(resumed.fresh).toBe(false);
  });

  it('is fresh exactly once per data directory', async () => {
    const dir = tempDir();
    const first = await open(dir);
    expect(first.fresh).toBe(true);
    expect(first.resumedDecisions).toBe(0);
    await first.close();

    const second = await open(dir);
    expect(second.fresh).toBe(false);
  });

  it('persists breaker floors and task attribution across restarts', async () => {
    const dir = tempDir();
    const agentId = newId('agt');
    const a = await open(dir);
    const engineA = new PolicyEngine(a);
    await engineA.addPolicy({
      policyId: 'pol_breaker',
      rules: [{ id: 'task-cap', escalate: { taskBudget: { gt: '5.00' } } }],
      breakers: [{ id: 'velocity', window: '1h', txCount: 2 }],
      default: 'allow',
    });
    await engineA.evaluateIntent({ ...intent(agentId, '1.00'), taskContext: { taskId: 't1' } });
    await engineA.evaluateIntent({ ...intent(agentId, '1.00'), taskContext: { taskId: 't1' } });
    // Clear the breaker the way an approval does, then prove the floor is
    // durable: a restart that forgot it would re-trip and ask a human the
    // same question again.
    //
    // The floor is a TIMESTAMP and the breaker counts `at >= cutoff`, so the
    // payments it is meant to put behind it have to be observably older than
    // the reset. Reading the wall clock here borrows that ordering from
    // machine speed: two awaited evaluations can land in the same millisecond
    // on a fast enough runner, leaving both payments AT the floor, counted
    // again, and the resumed breaker still tripped (the S50 macOS shape).
    // Stamping the reset one millisecond after the last allowance says the
    // ordering out loud, which is what an approval arriving later really is.
    const clearedAt = Math.max(...a.spend.allowancesIn(0).map((r) => r.at)) + 1;
    await a.spend.resetBreaker(agentId, 'velocity', clearedAt);
    await a.close();

    const b = await open(dir);
    const engineB = new PolicyEngine(b);
    expect(b.spend.breakerResets(agentId).velocity).toBe(clearedAt);
    expect(engineB.breakerStates(agentId)[0]?.tripped).toBe(false);
    // Task attribution survived, so the budget still counts what was spent.
    expect(b.spend.contextFor(agentId).taskSum('t1')).toBe('2');
    expect(b.spend.contextFor(agentId).taskSum('t2')).toBe('0');
  });

  it('reconciliation survives a restart — settled payments stay settled (B1)', async () => {
    const dir = tempDir();
    const agentId = newId('agt');
    const a = await open(dir);
    const engineA = new PolicyEngine(a);
    await engineA.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    const paid = await engineA.evaluateIntent(intent(agentId, '1.00'));
    const lost = await engineA.evaluateIntent(intent(agentId, '2.00'));
    await engineA.recordSettlement({
      intentId: paid.intent.id,
      txHash: '0xdeadbeef',
      source: 'indexer',
      confirmedAt: new Date(),
    });
    expect(engineA.reconcile({ graceMs: 0 })).toMatchObject({ settled: 1, unsettled: 1 });
    await a.close();

    // The whole point of persisting settlements: without them the restart
    // itself would raise the alarm, reporting every resumed allowance as a
    // payment nobody can account for.
    const b = await open(dir);
    const engineB = new PolicyEngine(b);
    const report = engineB.reconcile({ graceMs: 0 });
    expect(report).toMatchObject({ allowed: 2, settled: 1, unsettled: 1, settlementsSeen: 1 });
    expect(report.gaps[0]?.intentId).toBe(lost.intent.id);
    expect(b.settlements.get(paid.intent.id)?.txHash).toBe('0xdeadbeef');
  });

  it('the earliest confirmation wins on disk too, so a restart cannot flip the answer (S51)', async () => {
    const dir = tempDir();
    const intentId = newId('int');
    const a = await open(dir);
    // The later confirmation arrives FIRST. Until S53 the row on disk was
    // first-arrival-wins while the engine in memory was earliest-wins: the
    // live engine answered 100 and the resumed one answered 200.
    await a.settlements.settle({ intentId, at: 200, source: 'guard', txHash: '0xguard' });
    await a.settlements.settle({ intentId, at: 100, source: 'indexer', txHash: '0xchain' });
    await a.settlements.settle({ intentId, at: 150, source: 'facilitator' });
    const live = a.settlements.get(intentId);
    expect(live).toMatchObject({ at: 100, source: 'indexer', txHash: '0xchain' });
    await a.close();

    const b = await open(dir);
    expect(b.settlements.count()).toBe(1);
    expect(b.settlements.get(intentId)).toEqual(live);
  });

  it('reads a pre-B1 spend row as unattributed, never as a gap', async () => {
    const dir = tempDir();
    const a = await open(dir);
    // Exactly the row an older build wrote: no intent id to join on. Counting
    // it as a gap would make upgrading a live data dir raise a false alarm
    // about every payment it ever allowed.
    await a.spend.record({
      agentId: newId('agt'),
      host: 'api.example.com',
      resource: '/v1/answer',
      amount: '3.00',
      at: Date.now(),
    });
    await a.close();

    const b = await open(dir);
    const report = new PolicyEngine(b).reconcile({ graceMs: 0 });
    expect(report).toMatchObject({ unattributed: 1, allowed: 0, unsettled: 0 });
    expect(report.gaps).toEqual([]);
  });

  it('persists the dead-man watch, its sighting and its alarm (B2)', async () => {
    const dir = tempDir();
    const agentId = newId('agt');
    const t0 = Date.now() - 86_400_000;

    const a = await open(dir);
    const monitorA = new LivenessMonitor({ store: a.livenessStore, startedAt: t0, now: () => t0 });
    const engineA = new PolicyEngine({ ...a, liveness: monitorA });
    await engineA.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    await engineA.watchLiveness({ agentId, interval: '15m', graceMs: 0, note: 'price poller' });
    await engineA.evaluateIntent({ ...intent(agentId, '1.00'), createdAt: new Date(t0) });
    expect(await monitorA.sweep(t0 + 3_600_000)).toHaveLength(1);
    await a.close();

    const b = await open(dir);
    // The engine's witness floor keeps a restart from ALARMING about silence
    // it did not see, but the panel would still be wrong if the sighting were
    // lost: every live agent would read as silent since boot.
    const bootedAt = t0 + 7_200_000;
    const monitorB = new LivenessMonitor({
      store: b.livenessStore,
      startedAt: bootedAt,
      now: () => bootedAt,
    });
    const state = monitorB.state(agentId, bootedAt);
    expect(state?.expectation.note).toBe('price poller');
    expect(state?.expectation.since.getTime()).toBe(t0);
    expect(state?.lastSeenAt).toBe(t0);
    expect(state?.lastSource).toBe('intent');
    // And the alarm stays raised, so the operator is not told twice about a
    // death they have already read (the breaker-floor lesson, A3).
    expect(state?.alertedAt).toBeDefined();
    expect(await monitorB.sweep(bootedAt + 86_400_000)).toHaveLength(0);

    // A sighting after the restart clears it, and the next death is news again.
    const recovery = await monitorB.seen(agentId, 'heartbeat', bootedAt + 60_000);
    expect(recovery?.silentMs).toBe(7_260_000);
    expect(monitorB.state(agentId, bootedAt + 60_000)?.alertedAt).toBeUndefined();
  });

  it('persists a parked escalation and its approver key (A2)', async () => {
    const dir = tempDir();
    const agentId = newId('agt');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const pem = publicKey.export({ type: 'spki', format: 'pem' }).toString();

    const a = await open(dir);
    const approvalsA = new ApprovalService({ store: a.approvalStore, ttlMs: 3_600_000 });
    const approver = await approvalsA.registerApprover({
      orgId: newId('org'),
      name: 'on-call',
      publicKey: pem,
    });
    const engineA = new PolicyEngine({ ...a, approvals: approvalsA });
    await engineA.addPolicy({
      policyId: 'pol_probation',
      rules: [],
      breakers: [{ id: 'probation', window: '1h', txCount: 1 }],
      default: 'allow',
    });
    await engineA.evaluateIntent(intent(agentId, '1.00')); // inside the envelope
    const parked = await engineA.evaluateIntent(intent(agentId, '1.00'));
    expect(parked.decision.outcome).toBe('escalate');
    const decisionId = parked.approval!.decisionId;
    const expiresAt = parked.approval!.expiresAt.getTime();
    await a.close();

    // A lost request would leave the money blocked (the breaker floor IS
    // durable, so it resumes tripped) with no challenge left to answer and no
    // record that a human was ever asked.
    const b = await open(dir);
    const approvalsB = new ApprovalService({ store: b.approvalStore, ttlMs: 3_600_000 });
    const engineB = new PolicyEngine({ ...b, approvals: approvalsB });
    const resumed = approvalsB.get(decisionId);
    expect(resumed?.status).toBe('pending');
    expect(resumed?.breakers).toEqual(['probation']);
    // The deadline rides in the record: a restart does not grant a stale
    // escalation a fresh lease.
    expect(resumed?.expiresAt.getTime()).toBe(expiresAt);
    expect(approvalsB.listApprovers().map((k) => k.id)).toEqual([approver.id]);

    // And the signature made against the ORIGINAL challenge still releases it
    // after the restart — which is the whole point of persisting the bytes.
    const challenges = approvalsB.challengesFor(resumed!);
    expect(challenges).toEqual(approvalsA.challengesFor(resumed!));
    const signature = signApproval(privateKey, {
      decisionId,
      intentHash: resumed!.intentHash,
      verdict: 'approve',
    });
    const resolved = await engineB.resolveEscalation({
      decisionId,
      intentHash: resumed!.intentHash,
      verdict: 'approve',
      approverKeyId: approver.id,
      signature,
    });
    expect(resolved.decision.outcome).toBe('allow');
    expect(resolved.request.status).toBe('approved');
    // The original escalation is never rewritten; the release is a SECOND
    // decision for the same intent.
    expect(resolved.decision.id).not.toBe(decisionId);
  });

  it('prunes resolved escalations but never a pending one', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const approvals = new ApprovalService({ store: a.approvalStore, ttlMs: 3_600_000 });
    const engine = new PolicyEngine({ ...a, approvals });
    await engine.addPolicy({
      policyId: 'pol_probation',
      rules: [],
      breakers: [{ id: 'probation', window: '1h', txCount: 1 }],
      default: 'allow',
    });
    const agentId = newId('agt');
    await engine.evaluateIntent(intent(agentId, '1.00'));
    const parked = await engine.evaluateIntent(intent(agentId, '1.00'));
    expect(parked.decision.outcome).toBe('escalate');

    // Nothing has resolved, and an aggressive TTL must not touch it: a lapsed
    // request is still owed its deny on the chain.
    expect(await a.prune({ resolvedApprovalsOlderThanMs: 1 })).toMatchObject({
      resolvedApprovals: 0,
    });
    expect(approvals.pending()).toHaveLength(1);
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
      labels: ['research', 'prod-trading'],
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
    expect(loaded?.labels).toEqual(['research', 'prod-trading']);
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

  describe('an externally held signing key (D1(c))', () => {
    const pkcs8 = () =>
      generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    it('signs the chain without the private half ever touching the data dir', async () => {
      const dir = tempDir();
      const pem = pkcs8();
      const a = await open(dir, pem);
      expect(a.keySource).toBe('external');
      expect(a.fresh).toBe(true);
      const engineA = new PolicyEngine(a);
      await engineA.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
      await engineA.evaluateIntent(intent(newId('agt'), '1.00'));
      const keyPem = a.publicKeyPem;
      await a.close();

      // The same key resumes the chain across the seam exactly as a stored one
      // does -- here in the flattened form a secret manager hands back.
      const b = await open(dir, pem.replace(/\n/g, '\\n'));
      expect(b.keySource).toBe('external');
      expect(b.fresh).toBe(false);
      expect(b.publicKeyPem).toBe(keyPem);
      const engineB = new PolicyEngine(b);
      await engineB.evaluateIntent(intent(newId('agt'), '2.00'));
      expect(verifyDecisionChain(engineB.decisions(), b.publicKeyPem)).toBe(true);
      await b.close();

      // Nothing private was written: the data dir alone cannot continue the
      // chain, and says so instead of quietly minting a new key under it.
      await expect(open(dir)).rejects.toThrow(/held externally/);
    });

    it('refuses a different key rather than fork the chain', async () => {
      const dir = tempDir();
      const a = await open(dir, pkcs8());
      await a.close();
      await expect(open(dir, pkcs8())).rejects.toThrow(/does not match/);
    });

    it('erases the stored plaintext copy once the same key is supplied from outside', async () => {
      const dir = tempDir();
      const a = await open(dir);
      expect(a.keySource).toBe('stored');
      const engineA = new PolicyEngine(a);
      await engineA.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
      await engineA.evaluateIntent(intent(newId('agt'), '1.00'));
      await a.close();

      // Read the key the way an operator migrating it would: from the row.
      const db = await openDb(dir);
      const { keyPair } = await loadOrCreateKeyPair(db);
      const pem = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
      await db.close();

      const b = await open(dir, pem);
      expect(b.keySource).toBe('external');
      expect(b.resumedDecisions).toBe(1);
      expect(verifyDecisionChain(new PolicyEngine(b).decisions(), b.publicKeyPem)).toBe(true);
      await b.close();

      // The plaintext copy is gone: the data dir alone can no longer sign.
      await expect(open(dir)).rejects.toThrow(/held externally/);
    });
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

/**
 * D1(b): the authority tier. Every other store here loses OBSERVATIONS when it
 * is not durable; this one loses (and, worse, resurrects) permission.
 */
describe('durable API keys', () => {
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });

  it('keeps an issued key working across a restart', async () => {
    const dir = tempDir();
    const first = await open(dir);
    const { secret } = await new ApiKeyAuth({ store: first.apiKeys }).issue({
      name: 'fleet',
      scopes: ['evaluate'],
    });
    await first.close();

    const resumed = await open(dir);
    expect(resumed.resumedApiKeys).toBe(1);
    const auth = new ApiKeyAuth({ store: resumed.apiKeys });
    expect(auth.authenticate(bearer(secret), 'evaluate').name).toBe('fleet');
    // The scope survived with it — a resumed key is not a blank admin.
    expect(() => auth.authenticate(bearer(secret), 'admin')).toThrow(/scope/);
  });

  /**
   * The failure that makes this table non-negotiable. Revocation is a WRITE:
   * with an in-memory store the operator's response to a leaked secret was
   * undone by the next deploy, and nothing anywhere said so.
   */
  it('keeps a revoked key dead across a restart', async () => {
    const dir = tempDir();
    const first = await open(dir);
    const issuing = new ApiKeyAuth({ store: first.apiKeys });
    const { key, secret } = await issuing.issue({ name: 'leaked', scopes: ['evaluate'] });
    await issuing.revoke(key.id);
    await first.close();

    const resumed = await open(dir);
    const auth = new ApiKeyAuth({ store: resumed.apiKeys });
    expect(() => auth.authenticate(bearer(secret), 'evaluate')).toThrow(/revoked/);
  });

  /**
   * Rotation's whole point is that a fleet rolls over one process at a time,
   * which a restart in the middle must not cut short: the outgoing digest and
   * its expiry are part of the record, not in-process bookkeeping.
   */
  it('resumes a rotation grace window rather than ending it', async () => {
    const dir = tempDir();
    const first = await open(dir);
    const issuing = new ApiKeyAuth({ store: first.apiKeys });
    const { key, secret: old } = await issuing.issue({ name: 'rolling', scopes: ['read'] });
    const { secret: fresh } = await issuing.rotate(key.id, { graceMs: 60_000 });
    await first.close();

    const resumed = await open(dir);
    // A fixed clock inside the window: the grace is dated, so asserting it
    // must not depend on how long the reopen took.
    const at = Date.now();
    const auth = new ApiKeyAuth({ store: resumed.apiKeys, now: () => at });
    expect(auth.authenticate(bearer(fresh), 'read').id).toBe(key.id);
    expect(auth.authenticate(bearer(old), 'read').id).toBe(key.id);

    // And past the window the outgoing secret is refused, as it would have
    // been had nothing restarted.
    const later = new ApiKeyAuth({ store: resumed.apiKeys, now: () => at + 3_600_000 });
    expect(() => later.authenticate(bearer(old), 'read')).toThrow(/no longer accepted/);
    expect(later.authenticate(bearer(fresh), 'read').id).toBe(key.id);
  });

  it('starts empty, and says so', async () => {
    const store = await open(tempDir());
    expect(store.resumedApiKeys).toBe(0);
    expect(new ApiKeyAuth({ store: store.apiKeys }).hasKeys()).toBe(false);
  });

  /**
   * `authenticate` writes `lastUsedAt` and DROPS the promise, so that usage
   * telemetry never sits on a request's critical path. Unawaited means still
   * in flight at shutdown, and PGlite closed under an in-flight query does not
   * throw — it never returns. Before the write rode the tail, this test hung
   * forever instead of failing, which is how the bug hid: a service that
   * served one authenticated request could not finish shutting down.
   */
  it('drains the usage write that authenticate fires and forgets', async () => {
    const dir = tempDir();
    const first = await open(dir);
    const { secret } = await new ApiKeyAuth({ store: first.apiKeys }).issue({
      name: 'busy',
      scopes: ['evaluate'],
    });
    new ApiKeyAuth({ store: first.apiKeys }).authenticate(
      { authorization: `Bearer ${secret}` },
      'evaluate',
    );
    // The hang was HERE, with no error to report it.
    await first.close();

    // And the drain is a real write, not just a wait: the sighting survived.
    const resumed = await open(dir);
    expect(new ApiKeyAuth({ store: resumed.apiKeys }).list()[0]?.lastUsedAt).toBeInstanceOf(Date);
  });
});

/**
 * Sprint 2's durable half: org attribution is a SIDECAR column, because a
 * `Decision` has no agentId and its canonical form hashes a fixed field set.
 * If the column did not resume, every decision on disk would read as
 * unattributed after a restart and a tenant's own history would vanish from
 * its own console.
 */
describe('durable tenant attribution', () => {
  const ORG = newId('org');

  async function agentIn(engine: PolicyEngine, orgId: string, name: string) {
    return engine.registerAgent({ id: newId('agt'), orgId, name, createdAt: new Date() });
  }

  it('resumes the decision-to-agent map, so scoped reads survive a restart', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const engineA = new PolicyEngine(a);
    await engineA.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    const mine = await agentIn(engineA, ORG, 'mine');
    const theirs = await agentIn(engineA, newId('org'), 'theirs');
    await engineA.evaluateIntent(intent(mine.id, '0.10'));
    await engineA.evaluateIntent(intent(theirs.id, '0.20'));
    expect(engineA.decisions({ orgId: ORG })).toHaveLength(1);
    await a.close();

    const b = await open(dir);
    const engineB = new PolicyEngine(b);
    expect(b.resumedDecisions).toBe(2);
    // The whole chain is still there for an operator...
    expect(engineB.decisions()).toHaveLength(2);
    expect(verifyDecisionChain(engineB.decisions(), b.log.publicKeyPem)).toBe(true);
    // ...and exactly one of them belongs to this org, after the restart.
    const scoped = engineB.decisions({ orgId: ORG });
    expect(scoped).toHaveLength(1);
    expect(scoped[0]?.intentHash).toBe(engineA.decisions({ orgId: ORG })[0]?.intentHash);
  });

  it('leaves a decision written before the column unattributed, and so invisible to a tenant', async () => {
    const dir = tempDir();
    const a = await open(dir);
    const engineA = new PolicyEngine(a);
    await engineA.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    const mine = await agentIn(engineA, ORG, 'mine');
    await engineA.evaluateIntent(intent(mine.id, '0.10'));
    await a.close();

    // Exactly what a pre-tenancy row looks like: the doc is intact, the
    // sidecar is NULL. Nobody can prove it belongs to the org now asking.
    const db = await openDb(dir);
    await db.query('UPDATE decisions SET agent_id = NULL');
    await db.close();

    const b = await open(dir);
    const engineB = new PolicyEngine(b);
    expect(engineB.decisions()).toHaveLength(1);
    expect(engineB.decisions({ orgId: ORG })).toEqual([]);
  });
});
