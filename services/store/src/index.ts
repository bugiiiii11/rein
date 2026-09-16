import type { PGlite } from '@electric-sql/pglite';
import { Decision } from '@reinconsole/core';
import { DecisionLog } from '@reinconsole/policy-engine';
import { openDb } from './db.js';
import { loadOrCreateKeyPair, type KeySource, type SigningKeyInput } from './keys.js';
import {
  PgAgentRegistry,
  PgApiKeyStore,
  PgApprovalStore,
  PgLivenessStore,
  PgPolicyStore,
  PgSettlementStore,
  PgSpendStore,
} from './stores.js';
import { PgEvidenceLedger, PgIntentStore } from './graph-stores.js';
import { PgSessionStore } from './signer-stores.js';
import { PgGateStore } from './gate-stores.js';

export {
  PgAgentRegistry,
  PgApiKeyStore,
  PgApprovalStore,
  PgLivenessStore,
  PgPolicyStore,
  PgSettlementStore,
  PgSpendStore,
} from './stores.js';
export { PgEvidenceLedger, PgIntentStore } from './graph-stores.js';
export { PgSessionStore } from './signer-stores.js';
export { PgGateStore } from './gate-stores.js';
export { openDb } from './db.js';
export { loadOrCreateKeyPair, parseSigningKey } from './keys.js';
export type { KeySource, SigningKeyInput } from './keys.js';

export interface ReinStoreOptions {
  /** PGlite data directory. Omit for an ephemeral in-memory database (tests). */
  dir?: string;
  /**
   * The engine's signing key, held OUTSIDE the data directory (D1(c)): a
   * PKCS#8 ed25519 PEM from a secret manager, or a parsed pair. Omit and the
   * store generates one on first boot and keeps it, plaintext, beside the
   * decisions it signs. See `loadOrCreateKeyPair` for what happens when the
   * two postures meet on one data dir.
   */
  signingKey?: SigningKeyInput;
}

/**
 * Structurally satisfies the engine's `EngineStores`, so composing a durable
 * engine is one line: `new PolicyEngine(await openReinStore({ dir }))`. The
 * `ledger` / `intents` fields back @reinconsole/graph the same way — one PGlite
 * database now persists engine state AND reputation evidence.
 */
export interface ReinStore {
  spend: PgSpendStore;
  policies: PgPolicyStore;
  agents: PgAgentRegistry;
  /** Settlement facts behind `engine.reconcile()` — see PgSettlementStore. */
  settlements: PgSettlementStore;
  /**
   * Dead-man expectations and sightings (B2). Deliberately NOT named
   * `liveness`: what the engine takes under that key is a `LivenessMonitor`,
   * and this is only its durable half. Compose it —
   * `new LivenessMonitor({ store: s.livenessStore })` — because the alarm's
   * channels and its once-per-silence bookkeeping are not persistence
   * concerns, and a store that guessed at them would pick the wrong ones.
   */
  livenessStore: PgLivenessStore;
  /**
   * Parked escalations and registered approver keys (A2). Named for the same
   * reason as `livenessStore`: what the engine takes under `approvals` is an
   * `ApprovalService`, and this is only its persistent half — compose it,
   * `new ApprovalService({ store: s.approvalStore })`, because the delivery
   * channels and the TTL are policy choices a store must not make.
   */
  approvalStore: PgApprovalStore;
  /**
   * Durable API keys (D1(b)) — pass to `new ApiKeyAuth({ store: s.apiKeys })`.
   * Named like `livenessStore` and `approvalStore` for the same reason: what a
   * server takes under `auth` is an `ApiKeyAuth`, and this is only its
   * persistent half. Composing it is what makes an issued key survive a
   * restart and a revoked one stay dead.
   */
  apiKeys: PgApiKeyStore;
  log: DecisionLog;
  /** Reputation evidence ledger — pass to `new ReputationGraph({ ledger })`. */
  ledger: PgEvidenceLedger;
  /** Intent correlation map — pass to `new ReputationGraph({ intents })`. */
  intents: PgIntentStore;
  /** Signer custody accounting — pass to `new SessionSigner({ store })`.
   *  Wallet private keys are NOT here; re-register wallets at boot. */
  sessions: PgSessionStore;
  /** Gate receipts + replay slots + counters — pass to `createGate({ store })`. */
  gate: PgGateStore;
  /** The engine's public verification key — stable across restarts. */
  publicKeyPem: string;
  /** `'stored'` (plaintext in `engine_keys`) or `'external'` (`signingKey` supplied). */
  keySource: KeySource;
  /** True when this open CREATED the store (nothing resumed) — callers may seed. */
  fresh: boolean;
  /** Number of decisions resumed from disk (0 on first boot). */
  resumedDecisions: number;
  /** Number of reputation subjects resumed from disk (0 on first boot). */
  resumedSubjects: number;
  /** Number of signer sessions resumed from disk (0 on first boot). */
  resumedSessions: number;
  /** Number of gate receipts resumed from disk (0 on first boot). */
  resumedReceipts: number;
  /** Number of API keys resumed from disk (0 on first boot). */
  resumedApiKeys: number;
  /**
   * TTL-prune the unbounded burn tables: signer voucher burns (dead once the
   * signer's 300s staleness window has long passed) and gate replay slots
   * (dead once the payment's on-chain authorization has expired — see
   * PgGateStore.pruneReplays for the mock-rails caveat behind the generous
   * default), plus resolved approval requests (history whose authoritative
   * copy is the decision chain). Runs once at open; long-lived servers should
   * call it periodically. Defaults: usedDecisions 1h, replays 24h,
   * resolvedApprovals 7d; pass 0 to skip one.
   */
  prune(options?: {
    usedDecisionsOlderThanMs?: number;
    replaysOlderThanMs?: number;
    resolvedApprovalsOlderThanMs?: number;
  }): Promise<{ usedDecisions: number; replays: number; resolvedApprovals: number }>;
  close(): Promise<void>;
}

const PRUNE_USED_DECISIONS_MS = 3_600_000; // 12x the signer's 300s staleness window
const PRUNE_REPLAYS_MS = 86_400_000; // authorizations expire in ~300s; 24h is generous
// Resolved escalations: the decision chain is the authoritative record of what
// was approved, so these rows are a convenience copy. A week keeps the console
// panel's recent history intact across restarts without accreting forever.
const PRUNE_RESOLVED_APPROVALS_MS = 7 * 86_400_000;

/**
 * Open (or create) a durable Rein store. Hydrates the working set, loads or
 * generates the signing key, and resumes the decision chain so the next
 * append continues from the last persisted hash.
 */
export async function openReinStore(options: ReinStoreOptions = {}): Promise<ReinStore> {
  const db = await openDb(options.dir);
  try {
    const { keyPair, created, source } = await loadOrCreateKeyPair(db, options.signingKey);
    const agents = await PgAgentRegistry.open(db);
    const policies = await PgPolicyStore.open(db);
    const spend = await PgSpendStore.open(db);
    const settlements = await PgSettlementStore.open(db);
    const liveness = await PgLivenessStore.open(db);
    const approvals = await PgApprovalStore.open(db);
    const apiKeys = await PgApiKeyStore.open(db);
    const ledger = await PgEvidenceLedger.open(db);
    const intents = await PgIntentStore.open(db);
    const sessions = await PgSessionStore.open(db);
    const gate = await PgGateStore.open(db);

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

    const prune = async (
      options: {
        usedDecisionsOlderThanMs?: number;
        replaysOlderThanMs?: number;
        resolvedApprovalsOlderThanMs?: number;
      } = {},
    ) => {
      const usedTtl = options.usedDecisionsOlderThanMs ?? PRUNE_USED_DECISIONS_MS;
      const replayTtl = options.replaysOlderThanMs ?? PRUNE_REPLAYS_MS;
      const approvalTtl = options.resolvedApprovalsOlderThanMs ?? PRUNE_RESOLVED_APPROVALS_MS;
      return {
        usedDecisions: usedTtl > 0 ? await sessions.pruneUsedDecisions(usedTtl) : 0,
        replays: replayTtl > 0 ? await gate.pruneReplays(replayTtl) : 0,
        // PENDING requests are never pruned, whatever this is set to: a lapsed
        // one is still owed its deny on the chain.
        resolvedApprovals: approvalTtl > 0 ? await approvals.pruneResolved(approvalTtl) : 0,
      };
    };
    // Boot-time sweep: restarts are when accretion actually bites (every boot
    // resumed the whole burn history until now).
    await prune();

    return {
      spend,
      policies,
      agents,
      settlements,
      livenessStore: liveness,
      approvalStore: approvals,
      apiKeys,
      log,
      ledger,
      intents,
      sessions,
      gate,
      publicKeyPem: log.publicKeyPem,
      keySource: source,
      fresh: created,
      resumedDecisions: resume.length,
      resumedSubjects: ledger.size,
      resumedSessions: sessions.size,
      resumedReceipts: gate.receipts().length,
      resumedApiKeys: apiKeys.size,
      prune,
      // Drain pending write-behind state (reputation evidence, gate telemetry,
      // API-key usage touches) before closing the handle — a clean shutdown
      // must flush to be durable. The db is closed even when a flush fails —
      // the handle must not leak — and the first flush failure is rethrown so
      // "clean" shutdown can't lie.
      //
      // `apiKeys` is here for a sharper reason than durability: ApiKeyAuth
      // fires its `lastUsedAt` write and drops the promise, and closing PGlite
      // with that query in flight HANGS rather than failing, so a service that
      // authenticated a request and then shut down never finished shutting
      // down. (Session writes are all awaited at the call site; nothing to
      // drain there.)
      close: async () => {
        const flushes = await Promise.allSettled([
          ledger.flush(),
          intents.flush(),
          gate.flush(),
          apiKeys.flush(),
        ]);
        await db.close();
        const failed = flushes.find((r) => r.status === 'rejected');
        if (failed) throw failed.reason;
      },
    };
  } catch (err) {
    await db.close().catch(() => undefined);
    throw err;
  }
}

export type { PGlite };
