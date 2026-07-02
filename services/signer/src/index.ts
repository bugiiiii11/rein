/**
 * @rein/signer — the session-key custody tier.
 *
 * SDK mode governs an agent that holds its own key: advisory, bypassable,
 * with shadow.spend as the tripwire. This tier removes the key from the agent
 * entirely. The signer holds the wallet; the agent holds a capped, expiring
 * session token; and every EIP-3009 signature is released only against an
 * engine-signed allow decision for the exact transfer being signed — verified
 * offline, used once. The kill switch stops being a request and becomes a
 * physical fact: no allow, no signature, no payment.
 */

export { SessionSigner, type SessionSignerOptions, type SignRequest, type SignResult } from './signer.js';
export { sessionPayerFor, createRemoteSessionPayer, type RemoteSessionPayerOptions } from './payer.js';
export { buildSignerServer } from './server.js';
export {
  InMemorySessionStore,
  hashToken,
  sessionState,
  DEFAULT_TTL_SECONDS,
  type SessionStorePort,
  type MaybePromise,
  type CreateSessionInput,
  type CreatedSession,
  type SessionState,
} from './sessions.js';
export { verifyVoucher, intentHashOf, type VoucherCheck } from './verify.js';
export { SignerError, type RefusalCode } from './errors.js';
