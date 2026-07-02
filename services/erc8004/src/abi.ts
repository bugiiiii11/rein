import { parseAbi } from 'viem';

/**
 * The slice of the ERC-8004 Identity Registry ABI Rein touches, verified
 * against the published ABIs (github.com/erc-8004/erc-8004-contracts, abis/)
 * in session 17. The registry is an upgradeable ERC-721 (URIStorage): tokenId
 * IS the spec's `agentId`.
 *
 * Only the `register(string)` overload is declared — the contract also has
 * `register()` and `register(string, (string,bytes)[])`, but a single overload
 * keeps viem call sites unambiguous and we always pass an agentURI.
 *
 * `getAgentWallet` returns `address(bytes20(metadata["agentWallet"]))` — the
 * ZERO address when unset/cleared, never a revert (even for a nonexistent
 * agent). `ownerOf` is standard OZ ERC-721 and DOES revert on nonexistent ids.
 */
export const identityRegistryAbi = parseAbi([
  'function register(string agentURI) returns (uint256 agentId)',
  'function ownerOf(uint256 tokenId) view returns (address)',
  'function tokenURI(uint256 tokenId) view returns (string)',
  'function getAgentWallet(uint256 agentId) view returns (address)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
]);

/** The one Reputation Registry read we use: a live self-consistency cross-check. */
export const reputationRegistryAbi = parseAbi([
  'function getIdentityRegistry() view returns (address)',
]);
