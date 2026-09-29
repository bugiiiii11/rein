import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newId } from '@reinconsole/core';
import { PolicyEngine, verifyDecisionChain } from '@reinconsole/policy-engine';
import { openDb, openReinStore } from './index.js';
import { migratePgliteToPostgres } from './migrate.js';

/**
 * PGlite -> Postgres (Sprint 11.2). Needs `REIN_TEST_DATABASE_URL`, like
 * pg-db.test.ts; skipped otherwise.
 */
const PG_URL = process.env.REIN_TEST_DATABASE_URL || undefined;

const pkcs8 = () =>
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function intent(agentId: string, amount: string, taskId?: string) {
  return {
    agentId,
    vendor: { host: 'api.example.com', address: '0x1' },
    resource: '/v1/answer',
    amount,
    asset: 'USDC' as const,
    chain: 'base' as const,
    ...(taskId ? { taskContext: { taskId } } : {}),
  };
}

describe.skipIf(PG_URL === undefined)('migratePgliteToPostgres', () => {
  const url = PG_URL!;
  const dirs: string[] = [];
  const schemas: string[] = [];
  const quiet = () => undefined;

  const tempDir = () => {
    const d = mkdtempSync(join(tmpdir(), 'rein-migrate-'));
    dirs.push(d);
    return d;
  };
  const schema = () => {
    const s = `rein_m_${newId('s').slice(2).toLowerCase()}`;
    schemas.push(s);
    return s;
  };

  afterAll(async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    for (const s of schemas) await client.query(`DROP SCHEMA IF EXISTS ${s} CASCADE`);
    await client.end();
    await new Promise((r) => setTimeout(r, 250));
    for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  /** A data dir with something in every part of the engine the pilot touches. */
  async function populatedDir(signingKey?: string) {
    const dir = tempDir();
    const store = await openReinStore({ dir, ...(signingKey ? { signingKey } : {}) });
    const engine = new PolicyEngine(store);
    const org = newId('org');
    const agent = await engine.registerAgent({ id: newId('agt'), orgId: org, name: 'runner', createdAt: new Date() });
    const frozen = await engine.registerAgent({ id: newId('agt'), orgId: org, name: 'frozen', createdAt: new Date() });
    await engine.addPolicy({ policyId: 'pol_b', rules: [], default: 'allow' });
    await engine.addPolicy({
      policyId: 'pol_a',
      appliesTo: { agents: [agent.id] },
      rules: [{ id: 'cap', deny: { amountGt: '0.50' } }],
      default: 'allow',
    });
    // Upsert moves pol_b to the END: the order the copy must preserve.
    await engine.addPolicy({ policyId: 'pol_b', rules: [], default: 'allow' });
    const paid = await engine.evaluateIntent(intent(agent.id, '0.10', 'task-1'));
    await engine.evaluateIntent(intent(agent.id, '0.20', 'task-1'));
    await engine.evaluateIntent(intent(agent.id, '0.90'));
    await engine.recordSettlement({
      intentId: paid.intent.id,
      txHash: '0xabc',
      source: 'indexer',
      confirmedAt: new Date(),
    });
    await engine.freeze(frozen.id);
    await store.close();
    return { dir, agentId: agent.id };
  }

  it('copies everything, verifies it, and the chain continues on the target', async () => {
    const key = pkcs8();
    const { dir, agentId } = await populatedDir(key);
    const target = schema();

    const report = await migratePgliteToPostgres({ fromDir: dir, databaseUrl: url, schema: target, signingKey: key, log: quiet });
    expect(report.status).toBe('copied');
    expect(report.decisions).toBe(3);
    expect(report.rows.policies).toBe(2);

    const store = await openReinStore({ databaseUrl: url, schema: target, signingKey: key });
    try {
      expect(store.fresh).toBe(false);
      expect(store.policies.list().map((p) => p.policyId)).toEqual(['pol_a', 'pol_b']);
      const engine = new PolicyEngine(store);
      expect(engine.reconcile({ graceMs: 0 })).toMatchObject({ allowed: 2, settled: 1, unsettled: 1 });
      expect(store.spend.contextFor(agentId).taskSum('task-1')).toBe('0.3');
      // The sequences moved past the copied rows: the next decision appends
      // after them, and the whole chain -- both sides of the move -- verifies.
      await engine.evaluateIntent(intent(agentId, '0.05'));
      const all = engine.decisions();
      expect(all).toHaveLength(4);
      expect(verifyDecisionChain(all, store.publicKeyPem)).toBe(true);
    } finally {
      await store.close();
    }
    const reopened = await openReinStore({ databaseUrl: url, schema: target, signingKey: key });
    try {
      expect(verifyDecisionChain(new PolicyEngine(reopened).decisions(), reopened.publicKeyPem)).toBe(true);
      expect(reopened.resumedDecisions).toBe(4);
    } finally {
      await reopened.close();
    }
  });

  it('is a no-op on a re-run, and refuses a target holding a different chain', async () => {
    const key = pkcs8();
    const { dir } = await populatedDir(key);
    const target = schema();
    await migratePgliteToPostgres({ fromDir: dir, databaseUrl: url, schema: target, signingKey: key, log: quiet });
    const again = await migratePgliteToPostgres({ fromDir: dir, databaseUrl: url, schema: target, signingKey: key, log: quiet });
    expect(again.status).toBe('already');

    // Another data dir, same key, pointed at the already-filled target.
    const other = await populatedDir(key);
    await expect(
      migratePgliteToPostgres({ fromDir: other.dir, databaseUrl: url, schema: target, signingKey: key, log: quiet }),
    ).rejects.toThrow(/does not continue the source chain/);
  });

  it('refuses the wrong key and leaves the target empty', async () => {
    const { dir } = await populatedDir(pkcs8());
    const target = schema();
    await expect(
      migratePgliteToPostgres({ fromDir: dir, databaseUrl: url, schema: target, signingKey: pkcs8(), log: quiet }),
    ).rejects.toThrow(/does not match/);
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      // The refusal precedes the copy: the schema may exist, its tables are empty.
      const n = await client
        .query(`SELECT COUNT(*)::int AS n FROM ${target}.decisions`)
        .then((r) => r.rows[0]?.n as number)
        .catch(() => 0);
      expect(n).toBe(0);
    } finally {
      await client.end();
    }
  });

  it('refuses a source dir that does not exist rather than copy an empty one', async () => {
    await expect(
      migratePgliteToPostgres({
        fromDir: join(tempDir(), 'no-such-dir'),
        databaseUrl: url,
        schema: schema(),
        signingKey: pkcs8(),
        log: quiet,
      }),
    ).rejects.toThrow(/does not exist/);
  });

  it('leaves a stored-key source exactly as it was: the rollback keeps its key', async () => {
    const { dir } = await populatedDir(); // key generated and STORED in the dir
    const db = await openDb(dir);
    const before = (await db.query<{ private_pem: string }>('SELECT private_pem FROM engine_keys')).rows[0]!.private_pem;
    await db.close();
    expect(before).not.toBe('');

    const target = schema();
    await migratePgliteToPostgres({ fromDir: dir, databaseUrl: url, schema: target, signingKey: before, log: quiet });

    const after = await openDb(dir);
    try {
      const row = (await after.query<{ private_pem: string }>('SELECT private_pem FROM engine_keys')).rows[0]!;
      expect(row.private_pem).toBe(before);
    } finally {
      await after.close();
    }
    // ...while the target holds only the public half.
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    try {
      const { rows } = await client.query(`SELECT private_pem FROM ${target}.engine_keys`);
      expect(rows).toEqual([{ private_pem: '' }]);
    } finally {
      await client.end();
    }
  });
});
