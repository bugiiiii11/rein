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
 * - `spend_records.task_id` is the A4 attribution: nullable, because an intent
 *   may carry no task, and a task budget deliberately never triggers on one.
 * - `breaker_resets` is the A3 counting FLOOR, one row per (agent, breaker) —
 *   it must be durable, or a restart would silently re-trip every breaker a
 *   human had already cleared and ask them the same question again.
 * - `spend_records.intent_id` / `.decision_id` are the B1 join keys: they make
 *   the spend ledger the ALLOWANCE ledger. Nullable, and rows written before
 *   B1 keep NULL — reconciliation counts those as unattributed rather than as
 *   gaps, so upgrading a live data dir cannot invent an alarm out of history.
 * - `settlements` is the other half of that join, one row per INTENT (a
 *   resolved escalation appends a second decision for the same intent, and one
 *   settlement settles it). It must be durable for the same reason the breaker
 *   floors are: without it every allowance resumed from disk would read
 *   unsettled, and the restart itself would raise the alarm.
 * - `agent_liveness` is the B2 dead-man state, one row per WATCHED agent: the
 *   expectation, the last sighting, and `alerted_at`. All three must be
 *   durable for the same reason the breaker floors are — a restart that forgot
 *   the sighting would call every live agent dead, and one that forgot
 *   `alerted_at` would re-announce every alarm an operator has already read.
 * - `approvers` / `approval_requests` are the A2 human-in-the-loop tier. A
 *   parked escalation is a payment waiting on a signature, so losing it across
 *   a restart is not a telemetry gap: the money is still blocked, the breaker
 *   that stopped it is still tripped (those floors ARE durable), and the
 *   challenge a human was asked to sign no longer exists to answer. The
 *   request doc carries its own TTL, so a restart resumes the original clock
 *   rather than granting an expired escalation a fresh lease.
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

CREATE TABLE IF NOT EXISTS breaker_resets (
  agent_id   TEXT NOT NULL,
  breaker_id TEXT NOT NULL,
  at         BIGINT NOT NULL,
  PRIMARY KEY (agent_id, breaker_id)
);

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

CREATE TABLE IF NOT EXISTS agent_liveness (
  agent_id     TEXT PRIMARY KEY,
  interval_str TEXT NOT NULL,
  grace_ms     BIGINT NOT NULL,
  since_ms     BIGINT NOT NULL,
  note         TEXT,
  last_seen_at BIGINT,
  last_source  TEXT,
  alerted_at   BIGINT
);

CREATE TABLE IF NOT EXISTS approvers (
  id  TEXT PRIMARY KEY,
  doc JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_requests (
  decision_id TEXT PRIMARY KEY,
  doc         JSONB NOT NULL
);

CREATE TABLE IF NOT EXISTS settlements (
  intent_id TEXT PRIMARY KEY,
  at        BIGINT NOT NULL,
  tx_hash   TEXT,
  chain     TEXT,
  amount    TEXT,
  source    TEXT
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
ALTER TABLE spend_records
  ADD COLUMN IF NOT EXISTS task_id TEXT;
ALTER TABLE spend_records
  ADD COLUMN IF NOT EXISTS intent_id TEXT;
ALTER TABLE spend_records
  ADD COLUMN IF NOT EXISTS decision_id TEXT;
`;

/**
 * Open (or create) the PGlite database and ensure the schema exists.
 *
 * The parent directories are created first because PGlite's own `mkdirSync` is
 * NOT recursive: it creates the leaf and throws ENOENT if the parent is
 * missing. That turns an ordinary deploy setting — a data dir nested more than
 * one level below a mounted volume — into a boot crash, and under a container
 * restart policy into a crash-loop whose cause is buried in the logs.
 *
 * Mode 0o700, because `engine_keys.private_pem` lives in here: the key that
 * signs every decision, sitting in a directory the default umask would have
 * made world-readable. (Only directories this call CREATES are affected —
 * node's mkdir does not chmod an existing one, and silently tightening a
 * directory an operator already placed is not this function's business. On
 * Windows the mode is ignored, as it is for every POSIX mode there.)
 */
export async function openDb(dir?: string): Promise<PGlite> {
  if (dir) await mkdir(dir, { recursive: true, mode: 0o700 });
  const db = dir ? new PGlite(dir) : new PGlite();
  await db.waitReady;
  await db.exec(SCHEMA);
  await db.exec(MIGRATIONS);
  return db;
}
