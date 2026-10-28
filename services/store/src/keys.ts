import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { Db, Queryable } from './pg-db.js';
import { keyIdOf, type DecisionLogKeyPair, type KeyEpoch } from '@reinconsole/policy-engine';

/** Where the engine's signing key lives: in `engine_keys`, or outside the data dir. */
export type KeySource = 'stored' | 'external';

/** A PKCS#8 PEM (ed25519), or an already-parsed pair. */
export type SigningKeyInput = string | DecisionLogKeyPair;

/**
 * Parse an externally supplied signing key. Accepts the PEM with real newlines
 * or with the literal `\n` some secret managers flatten it to, and refuses
 * anything but ed25519 — the chain's verifier assumes that curve.
 */
export function parseSigningKey(input: SigningKeyInput): DecisionLogKeyPair {
  if (typeof input !== 'string') return input;
  const pem = input.replace(/\\n/g, '\n').trim();
  let privateKey: KeyObject;
  try {
    privateKey = createPrivateKey(pem);
  } catch (err) {
    throw new TypeError(
      `engine signing key is not a readable PKCS#8 PEM: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new TypeError(
      `engine signing key must be ed25519, got ${privateKey.asymmetricKeyType ?? 'unknown'}`,
    );
  }
  return { privateKey, publicKey: createPublicKey(privateKey) };
}

const spkiPem = (key: KeyObject): string => key.export({ type: 'spki', format: 'pem' }).toString();

/** What `loadOrCreateKeyPair` resolved: the key, and every key that signed before it. */
export interface LoadedKeys {
  keyPair: DecisionLogKeyPair;
  created: boolean;
  source: KeySource;
  /** Retired keys, oldest first -- feed to `DecisionLog` as `retiredKeys`. */
  retiredKeys: KeyEpoch[];
  /** Chain index of the first link the current key signs (`DecisionLog.keyFrom`). */
  keyFrom: number;
  /** The id of the key this open retired, when it rotated. */
  rotatedFrom?: string;
}

/**
 * The chain's key schedule as stored: retired keys from `engine_key_history`,
 * and the index the current key took over at. Read-only; `verify-dump` and
 * the migration's check use it to verify a chain that has been rotated.
 */
export async function readKeyHistory(db: Queryable): Promise<{ retiredKeys: KeyEpoch[]; keyFrom: number }> {
  const rows = (
    await db.query<{ from_index: string | number; until_index: string | number; public_pem: string }>(
      'SELECT from_index, until_index, public_pem FROM engine_key_history ORDER BY from_index',
    )
  ).rows;
  return {
    retiredKeys: rows.map((r) => ({ publicKeyPem: r.public_pem, from: Number(r.from_index) })),
    keyFrom: rows.length === 0 ? 0 : Number(rows[rows.length - 1]!.until_index),
  };
}

/**
 * Load the engine's ed25519 signing key. A stable key is what keeps the
 * resumed decision chain verifiable against the same `publicKeyPem` across
 * restarts, so the key's identity is pinned in `engine_keys` either way.
 *
 * Without `signingKey`: generate and persist one on first boot. The private
 * key then lives in the same database as the decisions it signs — the
 * single-node posture, appropriate for dev.
 *
 * With `signingKey` (D1(c)): the private half comes from outside — a secret
 * manager, `REIN_ENGINE_SIGNING_KEY` on the bin — and NEVER touches the data
 * dir. Only the public half is written, which is what lets the next open tell
 * a different key apart from the same one. A chain signed by another key is
 * refused rather than forked, and a plaintext copy left by an earlier boot is
 * erased once the same key arrives from outside. Once external, always
 * external: a boot that forgot the key fails, instead of minting a new one
 * and starting a second chain nobody asked for.
 */
export async function loadOrCreateKeyPair(
  db: Db,
  signingKey?: SigningKeyInput,
  options: { rotateFrom?: string } = {},
): Promise<LoadedKeys> {
  const existing = await db.query<{ private_pem: string; public_pem: string }>(
    `SELECT private_pem, public_pem FROM engine_keys WHERE id = 'engine'`,
  );
  const row = existing.rows[0];
  const history = await readKeyHistory(db);

  if (signingKey !== undefined) {
    const keyPair = parseSigningKey(signingKey);
    const publicPem = spkiPem(keyPair.publicKey);
    if (!row) {
      await db.query(
        `INSERT INTO engine_keys (id, private_pem, public_pem) VALUES ('engine', '', $1)`,
        [publicPem],
      );
      return { keyPair, created: true, source: 'external', ...history };
    }
    // Re-export rather than compare text: same key, same bytes, whatever
    // line endings the stored copy carries.
    if (spkiPem(createPublicKey(row.public_pem)) !== publicPem) {
      const rotated = await rotateKey(db, row, publicPem, history, options.rotateFrom);
      return { keyPair, created: false, source: 'external', ...rotated };
    }
    if (row.private_pem !== '') {
      await db.query(`UPDATE engine_keys SET private_pem = '' WHERE id = 'engine'`);
      await erasePrivateKeyBytes(db);
    }
    return { keyPair, created: false, source: 'external', ...history };
  }

  if (row) {
    if (row.private_pem === '') {
      throw new Error(
        "this data directory's engine signing key is held externally; set " +
          'REIN_ENGINE_SIGNING_KEY (or pass `signingKey`) to resume its decision chain',
      );
    }
    return {
      keyPair: {
        privateKey: createPrivateKey(row.private_pem),
        publicKey: createPublicKey(row.public_pem),
      },
      created: false,
      source: 'stored',
      ...history,
    };
  }

  const keyPair = generateKeyPairSync('ed25519');
  await db.query(`INSERT INTO engine_keys (id, private_pem, public_pem) VALUES ('engine', $1, $2)`, [
    keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    spkiPem(keyPair.publicKey),
  ]);
  return { keyPair, created: true, source: 'stored', ...history };
}

/**
 * Retire the chain's current key and continue the SAME chain under a new one
 * (S112, after the Railway breach put the engine's key in a stranger's hands).
 *
 * Opt-in by naming the key being retired: `rotateFrom` must equal the current
 * key's id (`keyIdOf`, also served at `/health` as `keyId`). A key that merely
 * differs is still refused, exactly as before rotation existed -- a wrong
 * secret pasted into a dashboard must stop the boot, not quietly start a new
 * epoch. Naming the key is the proof the operator meant it.
 *
 * The boundary is the chain length at this moment: the retired key keeps the
 * links it already signed, the new key signs every link from here on, and the
 * first new link's `prevHash` is the last old one's hash, so the chain stays
 * one chain. A key that signed nothing (rotated twice before a decision) is
 * dropped rather than recorded: an empty stretch has no links to verify.
 */
async function rotateKey(
  db: Db,
  row: { private_pem: string; public_pem: string },
  publicPem: string,
  history: { retiredKeys: KeyEpoch[]; keyFrom: number },
  rotateFrom: string | undefined,
): Promise<Omit<LoadedKeys, 'keyPair' | 'created' | 'source'>> {
  const currentId = keyIdOf(row.public_pem);
  if (rotateFrom === undefined) {
    throw new Error(
      "engine signing key does not match the key that signed this data directory's " +
        `decision chain (key ${currentId}); a chain cannot be continued under another key ` +
        'unless the rotation is explicit: set REIN_ENGINE_KEY_ROTATE_FROM to the id of the key being retired',
    );
  }
  if (rotateFrom.trim().toLowerCase() !== currentId) {
    throw new Error(
      `REIN_ENGINE_KEY_ROTATE_FROM names key ${rotateFrom.trim()}, but this chain is signed by ${currentId}; ` +
        'refusing to rotate a key that is not the current one',
    );
  }
  const newId = keyIdOf(publicPem);
  if (history.retiredKeys.some((epoch) => keyIdOf(epoch.publicKeyPem) === newId)) {
    throw new Error(`key ${newId} was already retired from this chain; a retired key never signs again`);
  }
  const length = Number(
    (await db.query<{ n: string | number }>('SELECT COUNT(*) AS n FROM decisions')).rows[0]?.n ?? 0,
  );
  const retiredKeys = [...history.retiredKeys];
  await db.transaction(async (tx) => {
    if (length > history.keyFrom) {
      await tx.query(
        'INSERT INTO engine_key_history (from_index, until_index, public_pem) VALUES ($1, $2, $3)',
        [history.keyFrom, length, row.public_pem],
      );
      retiredKeys.push({ publicKeyPem: row.public_pem, from: history.keyFrom });
    }
    await tx.query(`UPDATE engine_keys SET private_pem = '', public_pem = $1 WHERE id = 'engine'`, [publicPem]);
  });
  // A stored key being rotated out leaves its plaintext in the heap and WAL
  // exactly as a stored key moving outside does (see erasePrivateKeyBytes).
  if (row.private_pem !== '') await erasePrivateKeyBytes(db);
  console.warn(
    `[rein] engine signing key ROTATED at chain index ${length}: ${currentId} retired, ${newId} signs from here. ` +
      'Remove REIN_ENGINE_KEY_ROTATE_FROM; re-pin signers to the new key (GET /health publicKey).',
  );
  return { retiredKeys, keyFrom: length, rotatedFrom: currentId };
}

/**
 * How many WAL segments to roll past before the one that recorded the key can
 * be considered gone. See `erasePrivateKeyBytes`; the number is small because
 * the insert being erased is always the data directory's FIRST write.
 */
const WAL_ROLLS = 3;

/**
 * Actually remove the old private key from the data directory.
 *
 * The `UPDATE` above does not, and this is the whole finding: Postgres is
 * MVCC, so an `UPDATE ... SET private_pem = ''` writes a NEW row version and
 * leaves the old one — private key PEM and all — readable in the heap. A D1(c)
 * migration that "moved the key out of the volume" had in fact left a
 * perfectly good copy inside it, which is the one claim about that feature
 * that had to be true. Two places hold those bytes, and each needs its own
 * statement:
 *
 * - the HEAP, cleared by `VACUUM FULL` — not plain `VACUUM`, which only marks
 *   the dead tuple's space reusable. The bytes then sit on the page until
 *   something happens to overwrite them, and on a one-row table nothing ever
 *   will. FULL rewrites the table into a new file and unlinks the old one.
 * - the WAL, which recorded the original INSERT verbatim. `CHECKPOINT` alone
 *   is not enough: it makes the segment unnecessary for recovery but leaves
 *   the file sitting there. `pg_switch_wal()` + `CHECKPOINT`, repeated, moves
 *   the write position far enough forward that Postgres recycles past it.
 *   Three rounds is generous rather than tuned: the write being erased is the
 *   first one this data directory ever made, so it is in the OLDEST segment —
 *   an engine that has been running long enough to need more rounds recycled
 *   that segment away by itself long ago.
 *
 * Best-effort, and loudly so. Nothing here can fail in a way that makes the
 * engine WRONG — the key is external now and the column is empty either way —
 * but a failure means bytes may remain, so it is reported rather than
 * swallowed. And the SECURITY.md caveat stands whatever happens: a volume that
 * was ever exposed while it held a stored key must be treated as compromised.
 * The remedy there is a new key, which starts a new chain — not a vacuum.
 */
async function erasePrivateKeyBytes(db: Db): Promise<void> {
  try {
    await db.query('VACUUM FULL engine_keys');
    await db.query('CHECKPOINT');
    for (let i = 0; i < WAL_ROLLS; i += 1) {
      await db.query('SELECT pg_switch_wal()');
      await db.query('CHECKPOINT');
    }
  } catch (err) {
    console.warn(
      '[rein] could not reclaim the old signing-key bytes ' +
        `(${err instanceof Error ? err.message : String(err)}); ` +
        'treat this data directory as still holding the previous private key',
    );
  }
}
