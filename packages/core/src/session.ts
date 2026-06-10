import { z } from 'zod';
import { AgentId, SessionId } from './ids.js';
import { DecimalString } from './money.js';

/**
 * A session-key grant: the signer tier's unit of delegated authority. The
 * agent process holds only the bearer token — the wallet key never leaves the
 * signer — and the stored record keeps a hash of the token, never the token
 * itself (it is returned exactly once, at creation).
 *
 * Caps here are the signer-side backstop UNDER whatever policy says: a
 * signature is released only when the engine allowed the intent AND the
 * session has room. Amounts are decimal strings in the asset's human units.
 */
export const Session = z.object({
  id: SessionId,
  agentId: AgentId,
  /** sha256 hex of the bearer token. */
  tokenHash: z.string(),
  /** Cumulative ceiling across the session's lifetime. Absent = uncapped. */
  capAmount: DecimalString.optional(),
  /** Ceiling per individual signature. Absent = uncapped. */
  maxPerPayment: DecimalString.optional(),
  expiresAt: z.coerce.date(),
  createdAt: z.coerce.date(),
  revokedAt: z.coerce.date().optional(),
});
export type Session = z.infer<typeof Session>;
