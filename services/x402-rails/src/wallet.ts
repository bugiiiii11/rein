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
import type { NetworkProfile } from './profiles.js';

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

/**
 * The address a private key controls, without the caller needing viem.
 *
 * Exists for scripts that hold a key and only want to know whose wallet it
 * is -- the live-run preflight, chiefly. Without it such a script has to
 * resolve viem on its own, which from the repo root (where the workspace
 * package is not a dependency) is a path-guessing exercise.
 */
export function addressForPrivateKey(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
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

/**
 * A public client for whichever network a profile names.
 *
 * `createBaseSepoliaClient` above stays as-is because it is exported API and
 * a Sepolia-only caller should not have to learn about profiles to keep
 * working. New code takes the profile: it is the difference between a reader
 * that follows the configured network and one that is Sepolia forever.
 */
export function createChainClient(
  profile: NetworkProfile,
  rpcUrl?: string,
): PublicClient<HttpTransport> {
  return createPublicClient({
    chain: profile.viemChain,
    transport: http(rpcUrl ?? profile.defaultRpcUrl),
  });
}

/** Atomic-unit USDC balance on a profile's network, using that profile's token. */
export async function getProfileUsdcBalance(
  client: PublicClient<HttpTransport>,
  address: Address,
  profile: NetworkProfile,
): Promise<bigint> {
  return client.readContract({
    address: profile.usdc,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  });
}
