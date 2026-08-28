import { mkdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

/**
 * Schema notes:
 * - `decisions.doc` is TEXT, not JSONB: the row is the exact bytes of
 *   JSON.stringify(decision), so the hash-chain content can never be disturbed
 *   by jsonb normalization (key order, numeric formatting).
 * - `agents.doc` / `policies.doc` are JSONB — not hash-critical, and queryable
 *   later. Both re-validate through their zod schemas on hydration.
 * - Frozen agents live in their own table (not a column) so freezing an id the
 *   registry has never seen persists too, mirroring InMemoryAgentRegistry.
 * - `policies.seq` is evaluation order: first-applicable-wins, and an upserted
 *   policy moves to the END, exactly like the in-memory store.
 * - `graph_*` hold @reinconsole/graph's reputation evidence (one aggregated row per
 *   subject + the settled-money edges + the in-flight intent correlation map).
 *   Scores are NEVER stored — they recompute from this evidence on demand. All
 *   `volume` columns are TEXT (decimal strings summed exactly); storing money
 *   as float would drift the scores. `refusals` is a small code->count JSONB.
 * - `signer_*` hold @reinconsole/signer's custody accounting: session grants (doc
 *   JSONB carries the Session — token HASH only, never a token; `spent` is a
 *   TEXT decimal beside it) and the burned-voucher set. Wallet private keys
 *   are deliberately NOT stored anywhere in this schema.
 * - `gate_*` hold @reinconsole/gate's vendor-side state: receipts (JSONB docs),
 *   burned replay slots (sha256 of the presented header), and the
 *   quoted/refused counters (settled derives from receipts).
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS engine_keys (
  id          TEXT PRIMARY KEY,
  private_pem TEXT NOT NULL,
  public_pem  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  seq    BIGSERIAL,
  id     TEXT PRIMARY KEY,
  doc    JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS frozen_agents (
  id TEXT PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS policies (
  policy_id TEXT PRIMARY KEY,
  seq       BIGINT NOT NULL,
  doc       JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS spend_records (
  seq      BIGSERIAL PRIMARY KEY,
  agent_id TEXT NOT NULL,
  host     TEXT NOT NULL,
  resource TEXT NOT NULL,
  amount   TEXT NOT NULL,
  at       BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS spend_records_agent_at ON spend_records (agent_id, at);

CREATE TABLE IF NOT EXISTS vendor_reputation (
  host  TEXT PRIMARY KEY,
  score DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS decisions (
  seq BIGSERIAL PRIMARY KEY,
  id  TEXT NOT NULL UNIQUE,
  doc TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_subjects (
  subject_key   TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  id            TEXT NOT NULL,
  first_seen_ms BIGINT NOT NULL,
  last_seen_ms  BIGINT NOT NULL,
  attempts      BIGINT NOT NULL,
  settled       BIGINT NOT NULL,
  volume        TEXT NOT NULL,
  shadow_spends BIGINT NOT NULL,
  disputes      BIGINT NOT NULL,
  endorsements  BIGINT NOT NULL,
  refusals      JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS graph_counterparties (
  subject_key TEXT NOT NULL,
  peer_key    TEXT NOT NULL,
  settled     BIGINT NOT NULL,
  volume      TEXT NOT NULL,
  PRIMARY KEY (subject_key, peer_key)
);

CREATE TABLE IF NOT EXISTS graph_intents (
  seq       BIGSERIAL PRIMARY KEY,
  intent_id TEXT NOT NULL UNIQUE,
  agent_id  TEXT NOT NULL,
  host      TEXT NOT NULL,
  amount    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS signer_sessions (
  seq        BIGSERIAL,
  id         TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  spent      TEXT NOT NULL,
  doc        JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS signer_used_decisions (
  decision_id TEXT PRIMARY KEY,
  burned_at   BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::BIGINT)
);

CREATE TABLE IF NOT EXISTS gate_receipts (
  seq BIGSERIAL PRIMARY KEY,
  id  TEXT NOT NULL UNIQUE,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS gate_replays (
  key       TEXT PRIMARY KEY,
  burned_at BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::BIGINT)
);

CREATE TABLE IF NOT EXISTS gate_counters (
  id      TEXT PRIMARY KEY,
  quoted  BIGINT NOT NULL,
  refused BIGINT NOT NULL
);
`;

/**
 * Additive migrations for data dirs created before the column existed.
 * `ADD COLUMN ... DEFAULT (volatile)` backfills existing rows at ALTER time —
 * pre-migration burns start their TTL clock at the migration, which is the
 * conservative direction (never prunes early).
 */
const MIGRATIONS = `
ALTER TABLE signer_used_decisions
  ADD COLUMN IF NOT EXISTS burned_at BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::BIGINT);
ALTER TABLE gate_replays
  ADD COLUMN IF NOT EXISTS burned_at BIGINT NOT NULL DEFAULT ((EXTRACT(EPOCH FROM now()) * 1000)::BIGINT);
`;

/**
 * Open (or create) the PGlite database and ensure the schema exists.
 *
 * The parent directories are created first because PGlite's own `mkdirSync` is
 * NOT recursive: it creates the leaf and throws ENOENT if the parent is
 * missing. That turns an ordinary deploy setting — a data dir nested more than
 * one level below a mounted volume — into a boot crash, and under a container
 * restart policy into a crash-loop whose cause is buried in the logs.
 */
export async function openDb(dir?: string): Promise<PGlite> {
  if (dir) await mkdir(dir, { recursive: true });
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  await db.exec(SCHEMA);
  await db.exec(MIGRATIONS);
  return db;
}
