import { z } from 'zod';

/**
 * The canonical string form of an ERC-8004 agent identity:
 *
 *     eip155:{chainId}:{identityRegistry}/{tokenId}
 *
 * The part before the `/` is the spec's registry reference verbatim (the
 * `agentRegistry` field of a registration file, CAIP-10 account form); the
 * tokenId is the ERC-721 id the Identity Registry minted (`agentId` in the
 * spec). This exact string is what `Agent.erc8004Id` / `Vendor.erc8004Id`
 * carry, AND the reputation-subject id a registered agent's evidence keys by.
 *
 * Casing is load-bearing: reputation subject keys for agent-kind ids are
 * case-sensitive unless they start with `0x` (see @reinconsole/graph
 * `normalizeSubject`), and an eip155 string does not. `formatErc8004Id`
 * therefore always emits the registry address in lowercase, and consumers must
 * never hand-build the string — parse then re-format to normalize.
 */

export interface Erc8004Ref {
  /** EIP-155 chain id (e.g. 8453 Base, 84532 Base Sepolia). */
  chainId: number;
  /** Identity Registry contract address, lowercase 0x-hex. */
  registry: string;
  /** ERC-721 tokenId — the spec's `agentId`. bigint: token ids exceed 2^53. */
  tokenId: bigint;
}

const REGISTRY_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const ID_PATTERN = /^eip155:(\d+):(0x[0-9a-fA-F]{40})\/(\d+)$/;

/** Build the canonical id string. Throws on a malformed ref (programmer error). */
export function formatErc8004Id(ref: Erc8004Ref): string {
  if (!Number.isSafeInteger(ref.chainId) || ref.chainId < 1) {
    throw new RangeError(`erc8004: bad chainId ${ref.chainId}`);
  }
  if (!REGISTRY_PATTERN.test(ref.registry)) {
    throw new RangeError(`erc8004: bad registry address ${ref.registry}`);
  }
  if (typeof ref.tokenId !== 'bigint' || ref.tokenId < 0n) {
    // The typeof guard matters for plain-JS callers: 1.5 < 0n is legal JS and
    // false, and would mint the unparseable "…/1.5".
    throw new RangeError(`erc8004: bad tokenId ${ref.tokenId}`);
  }
  return `eip155:${ref.chainId}:${ref.registry.toLowerCase()}/${ref.tokenId}`;
}

/**
 * Parse a canonical (or hand-written) id string. Accepts any address casing
 * and returns a lowercase ref, or undefined when malformed — so
 * `formatErc8004Id(parseErc8004Id(x)!)` is the normalization step.
 */
export function parseErc8004Id(value: string): Erc8004Ref | undefined {
  const match = ID_PATTERN.exec(value);
  if (!match) return undefined;
  const chainId = Number(match[1]);
  if (!Number.isSafeInteger(chainId) || chainId < 1) return undefined;
  return {
    chainId,
    registry: match[2]!.toLowerCase(),
    tokenId: BigInt(match[3]!),
  };
}

/** Strict boundary schema for the id string (the fields themselves stay free-form). */
export const Erc8004Id = z
  .string()
  .refine((value) => parseErc8004Id(value) !== undefined, {
    message: 'expected "eip155:{chainId}:{registry}/{tokenId}"',
  });
export type Erc8004Id = z.infer<typeof Erc8004Id>;
