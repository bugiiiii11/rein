import { z } from 'zod';
import { ApiKeyId } from './ids.js';

/**
 * What a key is allowed to reach. `admin` satisfies every requirement (it is
 * the issuing/rotating key); the rest are least-privilege grants so an agent
 * runtime carrying an `evaluate` key cannot rewrite policy, and an approval
 * relay cannot read the spend history.
 *
 * `report` is the graph's ingestion grant, and it is deliberately NOT folded
 * into `evaluate`: evidence written to the reputation graph is about OTHER
 * subjects, so a fleet key that may spend its own budget has no business
 * moving a vendor's score. The engine's own reporting routes ride `evaluate`
 * because there the reporter IS the spender — that reasoning does not reach
 * across to a shared graph.
 */
export const ApiKeyScope = z.enum(['read', 'evaluate', 'approve', 'report', 'admin']);
export type ApiKeyScope = z.infer<typeof ApiKeyScope>;

/**
 * The public view of an API key — everything except the secret. This is what
 * the API returns on list/issue; the secret itself is shown exactly once, at
 * issuance, and never persisted in recoverable form (see {@link ApiKeyRecord}).
 */
export const ApiKey = z.object({
  id: ApiKeyId,
  name: z.string().min(1).max(200),
  scopes: z.array(ApiKeyScope).min(1),
  createdAt: z.coerce.date(),
  /** Last successful authentication, for spotting keys that can be retired. */
  lastUsedAt: z.coerce.date().optional(),
  /** Set by revoke(); a revoked key never authenticates again. */
  revokedAt: z.coerce.date().optional(),
  /** Set by rotate(); with `previousSecretExpiresAt` it dates the overlap. */
  rotatedAt: z.coerce.date().optional(),
});
export type ApiKey = z.infer<typeof ApiKey>;

/**
 * SERVER-SIDE ONLY. The stored form: the public record plus sha256 digests of
 * the secrets. Digests, not secrets — a stolen database yields nothing that
 * authenticates. Rotation keeps the outgoing digest alive until
 * `previousSecretExpiresAt` so a running fleet can roll over without a
 * flag-day restart; past that instant only the current secret verifies.
 *
 * This shape never leaves the engine: every route answers with {@link ApiKey}.
 */
export const ApiKeyRecord = ApiKey.extend({
  secretHash: z.string(),
  previousSecretHash: z.string().optional(),
  previousSecretExpiresAt: z.coerce.date().optional(),
});
export type ApiKeyRecord = z.infer<typeof ApiKeyRecord>;

/** Strip the digests: the only sanctioned way to put a key on the wire. */
export function toPublicApiKey(record: ApiKeyRecord): ApiKey {
  const { secretHash, previousSecretHash, previousSecretExpiresAt, ...pub } = record;
  void secretHash;
  void previousSecretHash;
  void previousSecretExpiresAt;
  return pub;
}
