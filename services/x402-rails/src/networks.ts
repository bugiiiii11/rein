/**
 * x402 network ids → EVM chain ids these rails can sign for. Accepts both the
 * v1 names ("base-sepolia") and the v2 CAIP-2 ids ("eip155:84532"). Unknown
 * networks return undefined — callers must fail closed.
 */
const NETWORK_TO_CHAIN_ID: Record<string, number> = {
  base: 8453,
  'eip155:8453': 8453,
  'base-sepolia': 84532,
  'eip155:84532': 84532,
};

export function chainIdForNetwork(network: string): number | undefined {
  return NETWORK_TO_CHAIN_ID[network.toLowerCase()];
}
