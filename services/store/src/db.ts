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
 * - `graph_*` hold @rein/graph's reputation evidence (one aggregated row per
 *   subject + the settled-money edges + the in-flight intent correlation map).
 *   Scores are NEVER stored — they recompute from this evidence on demand. All
 *   `volume` columns are TEXT (decimal strings summed exactly); storing money
 *   as float would drift the scores. `refusals` is a small code->count JSONB.
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
`;

/** Open (or create) the PGlite database and ensure the schema exists. */
export async function openDb(dir?: string): Promise<PGlite> {
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  await db.exec(SCHEMA);
  return db;
}
