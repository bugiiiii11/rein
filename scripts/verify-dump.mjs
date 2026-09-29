#!/usr/bin/env node
/**
 * Prove a nightly `pg_dump` of the engine database is a BACKUP (Sprint 11.4):
 * restored into a scratch Postgres, it must hold a decision chain that
 * verifies under the engine's public key, stored beside it. A dump that
 * restores but does not verify is a file, not a backup -- and a nightly that
 * only checked pg_dump's exit code would commit it just the same.
 *
 *   REIN_VERIFY_URL=postgres://... REIN_DB_SCHEMA=rein \
 *     node scripts/verify-dump.mjs --manifest <out.json>
 *
 * Writes a manifest (counts, last decision, chain digest) and exits 1 on any
 * failure. Needs `pnpm --filter @reinconsole/policy-engine... build`.
 */
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import pg from '../services/store/node_modules/pg/lib/index.js';
import { verifyDecisionChain } from '../services/policy-engine/dist/index.js';
import { Decision } from '../packages/core/dist/index.js';

const url = process.env.REIN_VERIFY_URL;
const schema = process.env.REIN_DB_SCHEMA || 'public';
const manifestAt = process.argv[process.argv.indexOf('--manifest') + 1];
if (!url) {
  console.error('verify-dump: REIN_VERIFY_URL is required');
  process.exit(1);
}
if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) {
  console.error(`verify-dump: invalid schema ${schema}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query(`SET search_path TO ${schema}`);
  const keys = (await client.query('SELECT public_pem, private_pem FROM engine_keys')).rows;
  if (keys.length !== 1) throw new Error(`expected one engine key row, found ${keys.length}`);
  if (keys[0].private_pem !== '') throw new Error('the dump holds a PRIVATE key -- it must never');
  const docs = (await client.query('SELECT doc FROM decisions ORDER BY seq')).rows.map((r) => r.doc);
  const chain = docs.map((doc) => Decision.parse(JSON.parse(doc)));
  if (!verifyDecisionChain(chain, keys[0].public_pem)) throw new Error('the restored decision chain does NOT verify');

  const count = async (t) => Number((await client.query(`SELECT COUNT(*) AS n FROM ${t}`)).rows[0].n);
  const h = createHash('sha256');
  for (const doc of docs) h.update(doc).update('\n');
  const last = chain.at(-1);
  const manifest = {
    verifiedAt: new Date().toISOString(),
    decisions: chain.length,
    lastDecision: last ? { id: last.id, decidedAt: last.decidedAt.toISOString(), hash: last.hash } : null,
    chainDigest: h.digest('hex'),
    agents: await count('agents'),
    policies: await count('policies'),
    spendRecords: await count('spend_records'),
    settlements: await count('settlements'),
    apiKeys: await count('api_keys'),
    // Starts at genesis: the WHOLE chain, not the org-scoped slice a
    // read-key HTTP export can see (handoff row 8, `rooted: false`).
    rooted: chain.length > 0 && chain[0].prevHash === 'genesis',
  };
  if (manifestAt) writeFileSync(manifestAt, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`verify-dump: ${chain.length} decisions verify; digest ${manifest.chainDigest.slice(0, 16)}...`);
} catch (err) {
  console.error(`verify-dump: ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await client.end();
}
