import { keccak256, stringToBytes, type Hex } from 'viem';

/**
 * Deterministic EIP-3009 nonce: keccak256(utf8(intent.id)).
 *
 * This is the on-chain memo. EIP-3009 only requires per-authorizer uniqueness
 * (intent ids are ULIDs, so collisions are off the table), and USDC emits
 * `AuthorizationUsed(authorizer, nonce)` on settlement — so the indexer can
 * recompute this for every allowed intent and reconcile transfers exactly,
 * the same memo-first semantics the mock rails get from a ledger memo field.
 */
export function intentNonce(intentId: string): Hex {
  return keccak256(stringToBytes(intentId));
}
