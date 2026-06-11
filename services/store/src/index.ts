import type { PGlite } from '@electric-sql/pglite';
import { Decision } from '@rein/core';
import { DecisionLog } from '@rein/policy-engine';
import { openDb } from './db.js';
import { loadOrCreateKeyPair } from './keys.js';
import { PgAgentRegistry, PgPolicyStore, PgSpendStore } from './stores.js';

export { PgAgentRegistry, PgPolicyStore, PgSpendStore } from './stores.js';
export { openDb } from './db.js';
export { loadOrCreateKeyPair } from './keys.js';

export interface ReinStoreOptions {
  /** PGlite data directory. Omit for an ephemeral in-memory database (tests). */
  dir?: string;
}

/**
 * Structurally satisfies the engine's `EngineStores`, so composing a durable
 * engine is one line: `new PolicyEngine(await openReinStore({ dir }))`.
 */
export interface ReinStore {
  spend: PgSpendStore;
  policies: PgPolicyStore;
  agents: PgAgentRegistry;
  log: DecisionLog;
  /** The engine's public verification key — stable across restarts. */
  publicKeyPem: string;
  /** True when this open CREATED the store (nothing resumed) — callers may seed. */
  fresh: boolean;
  /** Number of decisions resumed from disk (0 on first boot). */
  resumedDecisions: number;
  close(): Promise<void>;
}

/**
 * Open (or create) a durable Rein store. Hydrates the working set, loads or
 * generates the signing key, and resumes the decision chain so the next
 * append continues from the last persisted hash.
 */
export async function openReinStore(options: ReinStoreOptions = {}): Promise<ReinStore> {
  const db = await openDb(options.dir);
  try {
    const { keyPair, created } = await loadOrCreateKeyPair(db);
    const agents = await PgAgentRegistry.open(db);
    const policies = await PgPolicyStore.open(db);
    const spend = await PgSpendStore.open(db);

    const persisted = await db.query<{ doc: string }>('SELECT doc FROM decisions ORDER BY seq');
    // doc is the exact JSON.stringify of the decision; zod re-validates and
    // coerces decidedAt back to a Date, which canonicalizes to the same bytes.
    const resume = persisted.rows.map((row) => Decision.parse(JSON.parse(row.doc)));

    const log = new DecisionLog({
      keyPair,
      resume,
      persist: async (decision) => {
        await db.query('INSERT INTO decisions (id, doc) VALUES ($1, $2)', [
          decision.id,
          JSON.stringify(decision),
        ]);
      },
    });

    return {
      spend,
      policies,
      agents,
      log,
      publicKeyPem: log.publicKeyPem,
      fresh: created,
      resumedDecisions: resume.length,
      close: () => db.close(),
    };
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }
}

export type { PGlite };
