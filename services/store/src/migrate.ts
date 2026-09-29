import { createHash, createPublicKey } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Decision } from '@reinconsole/core';
import { PolicyEngine, verifyDecisionChain } from '@reinconsole/policy-engine';
import { openDb, openNetworkDb } from './db.js';
import type { Db } from './pg-db.js';
import { openReinStore, type ReinStore } from './index.js';
import { parseSigningKey, type SigningKeyInput } from './keys.js';

/**
 * PGlite data directory -> network Postgres (Sprint 11.2).
 *
 * Every table, every row, with the BIGSERIAL `seq` values carried over rather
 * than renumbered: `seq` is the decision chain's order and the policies'
 * evaluation order, and the sequences are moved past the copied maximum so
 * the next insert continues instead of colliding. `decisions.doc` is TEXT and
 * travels as the exact bytes it was stored as (see db.ts: jsonb normalization
 * would disturb the hash-chain content).
 *
 * `engine_keys` crosses as the PUBLIC half only, whatever the source holds: a
 * network database never keeps the private key (see openReinStore), so a
 * source that stored its key plaintext needs that key supplied from outside,
 * and it must be the same key.
 *
 * The copy is one transaction on the target; a failure leaves it empty. Then
 * the target is VERIFIED from what was written, not from memory: per-table
 * row counts, the byte-identical decision docs in `seq` order, the chain
 * verifying under the key, and the same stores hydrated from both sides
 * giving the same reconciliation, agents, policy order and API keys.
 *
 * The source is only ever READ. Its stores are opened with `pruneOnOpen:
 * false`, and never with the external key while it still holds a stored one
 * (that combination erases the stored copy -- see loadOrCreateKeyPair) --
 * the volume is the rollback and stays exactly as it was.
 */

/** Every table in db.ts, parents of nothing: no foreign keys, so any order works. */
const TABLES = [
  'engine_keys',
  'agents',
  'frozen_agents',
  'policies',
  'spend_records',
  'breaker_resets',
  'vendor_reputation',
  'decisions',
  'graph_subjects',
  'graph_counterparties',
  'graph_intents',
  'signer_sessions',
  'signer_used_decisions',
  'gate_receipts',
  'gate_replays',
  'gate_counters',
  'agent_liveness',
  'approvers',
  'approval_requests',
  'api_keys',
  'settlements',
] as const;

/** BIGSERIAL columns whose sequence must continue past the copied rows. */
const SERIALS: ReadonlyArray<readonly [table: string, column: string]> = [
  ['agents', 'seq'],
  ['spend_records', 'seq'],
  ['decisions', 'seq'],
  ['graph_intents', 'seq'],
  ['signer_sessions', 'seq'],
  ['gate_receipts', 'seq'],
];

const BATCH = 200;

export interface MigrateOptions {
  /** The PGlite data directory to copy FROM. Read only. */
  fromDir: string;
  /** The network Postgres to copy TO. */
  databaseUrl: string;
  schema?: string;
  /** The engine's signing key -- required, as it is for any network store. */
  signingKey: SigningKeyInput;
  /** Progress lines; defaults to console.log. */
  log?: (line: string) => void;
}

export interface MigrationReport {
  /** 'copied' = this run filled an empty target; 'already' = the target already holds this source. */
  status: 'copied' | 'already';
  rows: Record<string, number>;
  decisions: number;
  /** sha256 over the decision docs in seq order -- identical on both sides. */
  chainDigest: string;
  reconciliation: unknown;
}

export async function migratePgliteToPostgres(options: MigrateOptions): Promise<MigrationReport> {
  const log = options.log ?? ((line: string) => console.log(line));
  if (!existsSync(options.fromDir)) {
    // openDb would CREATE an empty database here and the migration would
    // "succeed" at copying nothing over a real target.
    throw new Error(`migrate: source data dir ${options.fromDir} does not exist`);
  }
  const keyPair = parseSigningKey(options.signingKey);
  const publicPem = spki(keyPair.publicKey);

  const source = await openDb(options.fromDir);
  const target = await openNetworkDb({
    url: options.databaseUrl,
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
  });
  let status: MigrationReport['status'];
  let sourceStoredKey: boolean;
  try {
    const srcKey = (
      await source.query<{ private_pem: string; public_pem: string }>(
        `SELECT private_pem, public_pem FROM engine_keys WHERE id = 'engine'`,
      )
    ).rows[0];
    if (!srcKey) throw new Error('migrate: the source has no engine key -- not a Rein data dir, or never booted');
    if (spki(createPublicKey(srcKey.public_pem)) !== publicPem) {
      throw new Error(
        'migrate: the signing key does not match the key that signed the source chain; ' +
          'a chain cannot be continued under another key',
      );
    }
    sourceStoredKey = srcKey.private_pem !== '';

    const counts = await rowCounts(target);
    const targetRows = Object.values(counts).reduce((a, b) => a + b, 0);
    if (targetRows === 0) {
      await copy(source, target, log);
      status = 'copied';
    } else {
      // A re-run (the boot hook stays set until someone removes it). Proceed
      // only if the target already holds THIS source's chain as a prefix;
      // anything else is a different database and must not be served from.
      await assertTargetContainsSource(source, target);
      log('[migrate] target already holds this source chain; nothing copied');
      status = 'already';
    }
  } finally {
    await source.close();
    await target.close();
  }

  const report = await verify(options, sourceStoredKey, status);
  log(
    `[migrate] verified: ${report.decisions} decisions, chain digest ${report.chainDigest.slice(0, 16)}..., ` +
      (status === 'copied'
        ? 'row counts, docs and reconciliation identical to the source'
        : 'the chain verifies and continues the source'),
  );
  return report;
}

async function copy(source: Db, target: Db, log: (line: string) => void): Promise<void> {
  await target.transaction(async (tx) => {
    for (const table of TABLES) {
      const rows = (await source.query<Record<string, unknown>>(`SELECT * FROM ${table}`)).rows;
      if (rows.length === 0) continue;
      const types = await columnTypes(source, table);
      const columns = Object.keys(rows[0]!);
      for (let i = 0; i < rows.length; i += BATCH) {
        const batch = rows.slice(i, i + BATCH);
        const params: unknown[] = [];
        const tuples = batch.map((row) => {
          const slots = columns.map((col) => {
            let value = row[col];
            if (table === 'engine_keys' && col === 'private_pem') value = '';
            params.push(toParam(value, types[col]));
            const cast = types[col] === 'jsonb' ? '::jsonb' : '';
            return `$${params.length}${cast}`;
          });
          return `(${slots.join(', ')})`;
        });
        await tx.query(`INSERT INTO ${table} (${columns.join(', ')}) VALUES ${tuples.join(', ')}`, params);
      }
      log(`[migrate] ${table}: ${rows.length} rows`);
    }
    for (const [table, column] of SERIALS) {
      // is_called=false on an empty table: the next value is 1, as on a fresh one.
      await tx.query(
        `SELECT setval(pg_get_serial_sequence('${table}', '${column}'),
                       COALESCE((SELECT MAX(${column}) FROM ${table}), 1),
                       (SELECT COUNT(*) FROM ${table}) > 0)`,
      );
    }
  });
}

function toParam(value: unknown, type: string | undefined): unknown {
  if (value === null || value === undefined) return null;
  // PGlite hands back a BIGINT beyond 2^53 as a JS bigint; pass it as text so
  // no digit is lost on the way in.
  if (typeof value === 'bigint') return value.toString();
  // JSONB arrives parsed; it goes back as text under an explicit cast, never
  // as an object (node-postgres would turn a JS array into a Postgres array).
  if (type === 'jsonb') return JSON.stringify(value);
  return value;
}

async function columnTypes(db: Db, table: string): Promise<Record<string, string>> {
  const { rows } = await db.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = $1 AND table_schema = current_schema()`,
    [table],
  );
  return Object.fromEntries(rows.map((r) => [r.column_name, r.data_type]));
}

async function rowCounts(db: Db): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const table of TABLES) {
    const { rows } = await db.query<{ n: string | number }>(`SELECT COUNT(*) AS n FROM ${table}`);
    out[table] = Number(rows[0]?.n ?? 0);
  }
  return out;
}

async function decisionDocs(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ doc: string }>('SELECT doc FROM decisions ORDER BY seq');
  return rows.map((r) => r.doc);
}

function digest(docs: readonly string[]): string {
  const h = createHash('sha256');
  for (const doc of docs) h.update(doc).update('\n');
  return h.digest('hex');
}

async function assertTargetContainsSource(source: Db, target: Db): Promise<void> {
  const src = await decisionDocs(source);
  const dst = await decisionDocs(target);
  const prefix = dst.slice(0, src.length);
  if (src.length > dst.length || digest(prefix) !== digest(src)) {
    throw new Error(
      `migrate: the target database is not empty and does not continue the source chain ` +
        `(source ${src.length} decisions, target ${dst.length}); refusing to serve from it. ` +
        'If the engine ran on the data dir AFTER a migration, the two have diverged -- reconcile by hand.',
    );
  }
}

async function verify(
  options: MigrateOptions,
  sourceStoredKey: boolean,
  status: MigrationReport['status'],
): Promise<MigrationReport> {
  const source = await openDb(options.fromDir);
  const target = await openNetworkDb({
    url: options.databaseUrl,
    ...(options.schema !== undefined ? { schema: options.schema } : {}),
  });
  let rows: Record<string, number>;
  let chainDigest: string;
  let decisions: number;
  try {
    const srcCounts = await rowCounts(source);
    const dstCounts = await rowCounts(target);
    const srcDocs = await decisionDocs(source);
    const dstDocs = await decisionDocs(target);
    if (status === 'copied') {
      for (const table of TABLES) {
        if (srcCounts[table] !== dstCounts[table]) {
          throw new Error(
            `migrate: ${table} has ${dstCounts[table]} rows on the target, ${srcCounts[table]} on the source`,
          );
        }
      }
      if (digest(srcDocs) !== digest(dstDocs)) {
        throw new Error('migrate: the decision docs differ byte-for-byte between source and target');
      }
      const key = (await target.query<{ private_pem: string }>('SELECT private_pem FROM engine_keys')).rows;
      if (key.length !== 1 || key[0]!.private_pem !== '') {
        throw new Error('migrate: the target engine_keys must hold exactly one row with no private key');
      }
    }
    rows = dstCounts;
    chainDigest = digest(dstDocs);
    decisions = dstDocs.length;
    const chain = dstDocs.map((doc) => Decision.parse(JSON.parse(doc)));
    const publicKeyPem = (await target.query<{ public_pem: string }>('SELECT public_pem FROM engine_keys'))
      .rows[0]!.public_pem;
    if (!verifyDecisionChain(chain, publicKeyPem)) {
      throw new Error('migrate: the decision chain on the target does not verify');
    }
  } finally {
    await source.close();
    await target.close();
  }

  // The stores as the engine will actually hydrate them, from both sides.
  // Never the external key on a source that still stores its own: that open
  // would erase the stored copy from the rollback volume.
  const src = await openReinStore({
    dir: options.fromDir,
    pruneOnOpen: false,
    ...(sourceStoredKey ? {} : { signingKey: options.signingKey }),
  });
  let dst: ReinStore | undefined;
  try {
    dst = await openReinStore({
      databaseUrl: options.databaseUrl,
      ...(options.schema !== undefined ? { schema: options.schema } : {}),
      signingKey: options.signingKey,
      pruneOnOpen: false,
    });
    const now = Date.now();
    const a = snapshot(src, now);
    const b = snapshot(dst, now);
    if (status === 'copied' && JSON.stringify(a) !== JSON.stringify(b)) {
      for (const k of Object.keys(a) as Array<keyof typeof a>) {
        if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) {
          throw new Error(`migrate: ${k} differs between the source and the target after the copy`);
        }
      }
    }
    return { status, rows, decisions, chainDigest, reconciliation: b.reconciliation };
  } finally {
    await src.close().catch(() => undefined);
    await dst?.close().catch(() => undefined);
  }
}

/** `now` is pinned by the caller, so both sides are reconciled at the same instant. */
function snapshot(store: ReinStore, now: number) {
  const engine = new PolicyEngine(store);
  return {
    reconciliation: engine.reconcile({ window: '36500d', graceMs: 0, now, limit: 1_000_000 }),
    agents: store.agents.list(),
    policies: store.policies.list().map((p) => p.policyId),
    apiKeys: store.apiKeys.size,
    settlements: store.settlements.count(),
    publicKeyPem: store.publicKeyPem,
  };
}

function spki(key: ReturnType<typeof createPublicKey>): string {
  return key.export({ type: 'spki', format: 'pem' }).toString();
}
