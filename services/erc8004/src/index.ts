/**
 * @rein/erc8004 — ERC-8004 Identity Registry integration.
 *
 * Reads on-chain identity facts (ownerOf, agentWallet) from the ratified
 * ERC-8004 Identity Registry (an ERC-721; tokenId = the spec's agentId) and
 * turns them into reputation-graph link facts: agents become erc8004-canonical
 * (one on-chain identity, one reputation), vendors stay host-canonical.
 * Also carries the write path (registerAgent) for the live demo, and the
 * in-memory MockIdentityRegistry twin for every offline path.
 */

export { identityRegistryAbi, reputationRegistryAbi } from './abi.js';
export { Erc8004Error, type Erc8004ErrorCode } from './errors.js';
export {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_REGISTRY,
  IDENTITY_REGISTRY_MAINNET,
  IDENTITY_REGISTRY_TESTNET,
  REPUTATION_REGISTRY_TESTNET,
  getIdentityRegistryAddress,
  identityRegistryReader,
  registerAgent,
  type IdentityRegistryReader,
  type RegisteredAgent,
  type RegistryChainReader,
  type RegistryRef,
} from './registry.js';
export { MockIdentityRegistry } from './mock.js';
export {
  agentLinkPairs,
  linkAgentFromRegistry,
  linkVendorFromRegistry,
  vendorLinkPairs,
  type LinkPair,
  type LinkSink,
  type LinkedIdentity,
} from './links.js';
