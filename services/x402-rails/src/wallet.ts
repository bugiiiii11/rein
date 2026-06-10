import {
  createPublicClient,
  erc20Abi,
  http,
  type Address,
  type Hex,
  type HttpTransport,
  type PublicClient,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';

/** USDC (FiatTokenV2) on Base Sepolia. */
export const BASE_SEPOLIA_USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** Circle's testnet faucet — funds Base Sepolia USDC for free. */
export const CIRCLE_FAUCET_URL = 'https://faucet.circle.com';

export const basescanTxUrl = (txHash: string): string =>
  `https://sepolia.basescan.org/tx/${txHash}`;

export interface GeneratedWallet {
  privateKey: Hex;
  address: Address;
}

/** A fresh local account — fund it with faucet USDC; it never needs ETH. */
export function generateWallet(): GeneratedWallet {
  const privateKey = generatePrivateKey();
  return { privateKey, address: privateKeyToAccount(privateKey).address };
}

export type BaseSepoliaClient = PublicClient<HttpTransport, typeof baseSepolia>;

export function createBaseSepoliaClient(rpcUrl?: string): BaseSepoliaClient {
  return createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
}

/** Atomic-unit USDC balance (6 decimals). */
export async function getUsdcBalance(
  client: BaseSepoliaClient,
  address: Address,
  usdc: Address = BASE_SEPOLIA_USDC,
): Promise<bigint> {
  return client.readContract({
    address: usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
}
