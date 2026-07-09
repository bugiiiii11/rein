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
  'function setAgentURI(uint256 agentId, string newURI)',
  'event Registered(uint256 indexed agentId, string agentURI, address indexed owner)',
  'event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy)',
]);

/**
 * The Reputation Registry slice Rein touches, verified against the published
 * ABI + contract source (ReputationRegistryUpgradeable.sol) in session 19:
 *
 * - `giveFeedback` is open to any clientAddress EXCEPT the agent's owner or
 *   an approved operator ("Self-feedback not allowed"); a nonexistent agentId
 *   reverts ERC721NonexistentToken via the Identity Registry.
 * - `feedbackIndex` is a 1-BASED counter per (agentId, clientAddress).
 * - `feedbackHash` is the KECCAK-256 of the content behind `feedbackURI`
 *   (optional for content-addressed URIs); bytes32(0) is accepted.
 * - `getSummary` returns the WAD-normalized AVERAGE of matching non-revoked
 *   feedback, scaled to the mode of the matched valueDecimals. LIVE-VERIFIED
 *   DIVERGENCE from the repo's main-branch source (S19): the DEPLOYED Base
 *   Sepolia contract REVERTS "clientAddresses required" on an empty client
 *   list — callers must resolve `getClients(agentId)` first (readSummary
 *   does). `readFeedback` reverts on an out-of-bounds index.
 * - `revokeFeedback` implicitly authorizes by msg.sender (the mapping is keyed
 *   by it — you can only ever revoke your OWN entries); reverts "index out of
 *   bounds" past your lastIndex and "Already revoked" on a second revoke.
 * - `appendResponse` is open to ANYONE, requires the referenced feedback to
 *   exist ("index out of bounds") and a non-empty URI ("Empty URI"); the
 *   responseURI/responseHash ride only the EVENT — reads expose counters.
 *
 * setAgentURI/revokeFeedback/appendResponse selectors AND their event topics
 * were verified present in the DEPLOYED Base Sepolia implementation bytecode
 * (EIP-1967 impl slots resolved, S25) — not just the repo source, which the
 * deployment is known to diverge from (the S19 getSummary lesson).
 */
export const reputationRegistryAbi = parseAbi([
  'function getIdentityRegistry() view returns (address)',
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex) view returns (int128 value, uint8 valueDecimals, string tag1, string tag2, bool isRevoked)',
  'function getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2) view returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)',
  'function getClients(uint256 agentId) view returns (address[])',
  'function getLastIndex(uint256 agentId, address clientAddress) view returns (uint64)',
  'function revokeFeedback(uint256 agentId, uint64 feedbackIndex)',
  'function appendResponse(uint256 agentId, address clientAddress, uint64 feedbackIndex, string responseURI, bytes32 responseHash)',
  'event NewFeedback(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, int128 value, uint8 valueDecimals, string indexed indexedTag1, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash)',
  'event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex)',
  'event ResponseAppended(uint256 indexed agentId, address indexed clientAddress, uint64 feedbackIndex, address indexed responder, string responseURI, bytes32 responseHash)',
]);
