import { generateKeyPairSync } from 'node:crypto';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import pg from 'pg';
import { newId } from '@reinconsole/core';
import { PolicyEngine, verifyDecisionChain } from '@reinconsole/policy-engine';
import { openReinStore, PgNetworkDb, type ReinStore } from './index.js';
import { redactUrl } from './server.js';

/**
 * The network driver's own contract (Sprint 11.1): what PGlite gave the
 * stores for free, and a connection string has to be made to give them.
 * Needs a real Postgres -- `REIN_TEST_DATABASE_URL`, set by CI's service
 * container; skipped otherwise, like the live suites. store.test.ts runs
 * against the same database with the same variable.
 */
const PG_URL = process.env.REIN_TEST_DATABASE_URL || undefined;

const pkcs8 = () =>
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

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

describe('redactUrl', () => {
  it('keeps host, port and database, never the credentials', () => {
    const shown = redactUrl('postgres://rein.abc:s3cret@aws-0-eu-west-1.pooler.supabase.com:5432/postgres');
    expect(shown).toBe('aws-0-eu-west-1.pooler.supabase.com:5432/postgres');
    expect(shown).not.toContain('s3cret');
  });
});

describe.skipIf(PG_URL === undefined)('network Postgres driver', () => {
  const url = PG_URL!;
  const schemas: string[] = [];
  const opened: Array<{ close(): Promise<void> }> = [];

  function schema(): string {
    const name = `rein_d_${newId('s').slice(2).toLowerCase()}`;
    schemas.push(name);
    return name;
  }

  async function store(name: string, signingKey: string): Promise<ReinStore> {
    const s = await openReinStore({ databaseUrl: url, schema: name, signingKey });
    opened.push(s);
    return s;
  }

  afterEach(async () => {
    while (opened.length) await opened.pop()!.close().catch(() => undefined);
  });

  afterAll(async () => {
    const client = new pg.Client({ connectionString: url });
    await client.connect();
    for (const name of schemas) await client.query(`DROP SCHEMA IF EXISTS ${name} CASCADE`);
    await client.end();
  });

  it('refuses to keep a private key in a network database', async () => {
    await expect(openReinStore({ databaseUrl: url, schema: schema() })).rejects.toThrow(
      /external signing key/,
    );
  });

  it('refuses a different key rather than fork the chain', async () => {
    const name = schema();
    await (await store(name, pkcs8())).close();
    await expect(store(name, pkcs8())).rejects.toThrow(/does not match/);
  });

  it('stores only the public half of the key', async () => {
    const name = schema();
    const s = await store(name, pkcs8());
    await s.close();
    const db = await PgNetworkDb.open({ url, schema: name });
    opened.push(db);
    const { rows } = await db.query<{ private_pem: string; public_pem: string }>(
      'SELECT private_pem, public_pem FROM engine_keys',
    );
    expect(rows).toEqual([{ private_pem: '', public_pem: expect.stringContaining('PUBLIC KEY') }]);
  });

  it('keeps policy evaluation order across a restart under concurrent upserts', async () => {
    // The reason the driver is ONE serialized connection and not a pool.
    // `policies.seq` is `MAX(seq) + 1` computed inside the insert; on a pool,
    // concurrent upserts each read the same MAX, tie, and the restart resumes
    // first-applicable-wins in whatever order Postgres returns the tie -- a
    // deny that was evaluated first can come back evaluated second. (Measured
    // S84: a 10-connection pool fails this; the chain test below does not,
    // because DecisionLog already serializes its own appends.)
    const name = schema();
    const key = pkcs8();
    const a = await store(name, key);
    const engineA = new PolicyEngine(a);
    await Promise.all(
      Array.from({ length: 30 }, (_, i) =>
        engineA.addPolicy({ policyId: `pol_${String(i).padStart(2, '0')}`, rules: [], default: 'allow' }),
      ),
    );
    const live = a.policies.list().map((p) => p.policyId);
    await a.close();

    const b = await store(name, key);
    expect(b.policies.list().map((p) => p.policyId)).toEqual(live);
  });

  it('resumes a decision chain written by concurrent evaluations', async () => {
    const name = schema();
    const key = pkcs8();
    const a = await store(name, key);
    const engineA = new PolicyEngine(a);
    await engineA.addPolicy({ policyId: 'pol_open', rules: [], default: 'allow' });
    await Promise.all(
      Array.from({ length: 40 }, (_, i) => engineA.evaluateIntent(intent(newId('agt'), `0.0${i % 10}`))),
    );
    const live = engineA.decisions().map((d) => d.id);
    await a.close();

    const b = await store(name, key);
    const resumed = new PolicyEngine(b).decisions();
    expect(resumed.map((d) => d.id)).toEqual(live);
    expect(verifyDecisionChain(resumed, b.publicKeyPem)).toBe(true);
  });

  it('holds the connection for a whole transaction, and rolls back on a throw', async () => {
    const db = await PgNetworkDb.open({ url, schema: schema() });
    opened.push(db);
    await db.exec('CREATE TABLE t (v INT)');

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const tx = db.transaction(async (q) => {
      await q.query('INSERT INTO t VALUES (1)');
      await gate;
      await q.query('INSERT INTO t VALUES (2)');
    });
    // Issued on the root handle mid-transaction: it must wait for COMMIT, not
    // run between the two inserts on the shared connection.
    const outside = db.query<{ n: string }>('SELECT count(*)::text AS n FROM t');
    release();
    await tx;
    expect((await outside).rows[0]?.n).toBe('2');

    await expect(
      db.transaction(async (q) => {
        await q.query('INSERT INTO t VALUES (3)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const after = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM t');
    expect(after.rows[0]?.n).toBe('2');
  });

  it('reconnects after the server drops the connection', async () => {
    const name = schema();
    const db = await PgNetworkDb.open({ url, schema: name });
    opened.push(db);
    const { rows } = await db.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');

    const admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query('SELECT pg_terminate_backend($1)', [rows[0]!.pid]);
    await admin.end();
    // Let the termination reach the client socket.
    await new Promise((r) => setTimeout(r, 200));

    // The first statement after the drop may fail (it could have been the one
    // in flight); the handle must not stay dead after it.
    await db.query('SELECT 1').catch(() => undefined);
    const again = await db.query<{ pid: number; s: string }>(
      'SELECT pg_backend_pid() AS pid, current_schema() AS s',
    );
    expect(again.rows[0]?.pid).not.toBe(rows[0]!.pid);
    // And the new connection is back in the same schema, not in `public`.
    expect(again.rows[0]?.s).toBe(name);
  });

  it('isolates schemas sharing one database', async () => {
    const key = pkcs8();
    const one = await store(schema(), key);
    const engine = new PolicyEngine(one);
    await engine.addPolicy({ policyId: 'pol_one', rules: [], default: 'allow' });
    const two = await store(schema(), key);
    expect(two.fresh).toBe(true);
    expect(two.policies.list()).toEqual([]);
  });

  it('rejects a schema name it would have to quote', async () => {
    await expect(PgNetworkDb.open({ url, schema: 'x; DROP TABLE decisions' })).rejects.toThrow(
      /invalid schema name/,
    );
  });
});
