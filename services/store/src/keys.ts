import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import type { PGlite } from '@electric-sql/pglite';
import type { DecisionLogKeyPair } from '@rein/policy-engine';

/**
 * Load the engine's ed25519 signing key, generating and persisting one on
 * first boot. A stable key is what keeps the resumed decision chain verifiable
 * against the same `publicKeyPem` across restarts.
 *
 * The private key lives in the same database as the decisions it signs —
 * appropriate for a dev/single-node deployment; production wants KMS.
 */
export async function loadOrCreateKeyPair(
  db: PGlite,
): Promise<{ keyPair: DecisionLogKeyPair; created: boolean }> {
  const existing = await db.query<{ private_pem: string; public_pem: string }>(
    `SELECT private_pem, public_pem FROM engine_keys WHERE id = 'engine'`,
  );
  const row = existing.rows[0];
  if (row) {
    return {
      keyPair: {
        privateKey: createPrivateKey(row.private_pem),
        publicKey: createPublicKey(row.public_pem),
      },
      created: false,
    };
  }

  const keyPair = generateKeyPairSync('ed25519');
  await db.query(`INSERT INTO engine_keys (id, private_pem, public_pem) VALUES ('engine', $1, $2)`, [
    keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  ]);
  return { keyPair, created: true };
}
