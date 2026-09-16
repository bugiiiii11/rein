import { createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { DecisionLogKeyPair } from '@reinconsole/policy-engine';

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
  db: PGlite,
  signingKey?: SigningKeyInput,
): Promise<{ keyPair: DecisionLogKeyPair; created: boolean; source: KeySource }> {
  const existing = await db.query<{ private_pem: string; public_pem: string }>(
    `SELECT private_pem, public_pem FROM engine_keys WHERE id = 'engine'`,
  );
  const row = existing.rows[0];

  if (signingKey !== undefined) {
    const keyPair = parseSigningKey(signingKey);
    const publicPem = spkiPem(keyPair.publicKey);
    if (!row) {
      await db.query(
        `INSERT INTO engine_keys (id, private_pem, public_pem) VALUES ('engine', '', $1)`,
        [publicPem],
      );
      return { keyPair, created: true, source: 'external' };
    }
    // Re-export rather than compare text: same key, same bytes, whatever
    // line endings the stored copy carries.
    if (spkiPem(createPublicKey(row.public_pem)) !== publicPem) {
      throw new Error(
        "engine signing key does not match the key that signed this data directory's " +
          'decision chain; a chain cannot be continued under another key',
      );
    }
    if (row.private_pem !== '') {
      await db.query(`UPDATE engine_keys SET private_pem = '' WHERE id = 'engine'`);
      await erasePrivateKeyBytes(db);
    }
    return { keyPair, created: false, source: 'external' };
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
    };
  }

  const keyPair = generateKeyPairSync('ed25519');
  await db.query(`INSERT INTO engine_keys (id, private_pem, public_pem) VALUES ('engine', $1, $2)`, [
    keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    spkiPem(keyPair.publicKey),
  ]);
  return { keyPair, created: true, source: 'stored' };
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
async function erasePrivateKeyBytes(db: PGlite): Promise<void> {
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
