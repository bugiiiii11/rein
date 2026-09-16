import { base, baseSepolia } from 'viem/chains';
import type { Address, Chain as ViemChain } from 'viem';
import { RailsError } from './errors.js';

/**
 * One network Rein can actually pay on, as a single value.
 *
 * Before this existed, "which network" was scattered across five defaults --
 * a USDC address in wallet.ts, a facilitator URL in facilitator.ts, a chain id
 * in networks.ts, an EIP-712 domain fallback in payer.ts, an explorer URL in
 * wallet.ts -- and moving to mainnet meant finding all five and agreeing with
 * yourself each time. A profile is the seam: one object, chosen once by the
 * composing app, and every rail reads its network facts off it.
 *
 * No env is read here, or anywhere in this package. A library that reaches for
 * `process.env` cannot be used twice in one process with two configurations,
 * and it is exactly the mainnet/testnet boundary where you want that to be
 * possible (a mainnet payer next to a testnet probe in the same test run).
 * Composing apps pass `process.env.REIN_NETWORK_PROFILE` through
 * `parseProfileName` and hand the result down.
 */
export interface NetworkProfile {
  /** Profile name as an operator writes it: `testnet` | `mainnet`. */
  name: ProfileName;
  /** x402 v1 network id, as it appears in a 402's `accepts[].network`. */
  network: string;
  /** The same network as a CAIP-2 id, the v2 dialect's spelling. */
  caip2: string;
  chainId: number;
  /** viem chain object, for public clients and wallet clients. */
  viemChain: ViemChain;
  /** Circle USDC on this network. */
  usdc: Address;
  /** USDC is 6 decimals on every chain Circle deploys to; pinned, not assumed. */
  decimals: 6;
  /**
   * The EIP-712 domain USDC's FiatTokenV2 verifies a TransferWithAuthorization
   * against. THIS DIFFERS BETWEEN THE TWO NETWORKS and it is the single most
   * dangerous constant in this file: Base Sepolia's token is named `USDC`,
   * Base mainnet's is named `USD Coin`. A signature built with the wrong name
   * is well-formed, costs nothing to produce, and is rejected by the contract
   * at settlement -- so it fails on mainnet only, after the money is meant to
   * move. `payer.ts` used to hardcode the Sepolia spelling as its fallback.
   */
  eip712: { name: string; version: string };
  /** Facilitator that verifies and settles for this network. */
  facilitatorUrl: string;
  /**
   * Whether that facilitator needs credentials. The hosted testnet facilitator
   * is open; every mainnet facilitator is not, and `cdp` is the one this
   * repo wires (see cdp.ts).
   */
  facilitatorAuth: 'none' | 'cdp';
  /** Public RPC, fine for reads and rate-limited under any real load. */
  defaultRpcUrl: string;
  /** Where an operator gets test funds. Mainnet has no faucet, by definition. */
  faucetUrl?: string;
  /** Block-explorer link for a settled transaction. */
  explorerTxUrl: (txHash: string) => string;
}

export type ProfileName = 'testnet' | 'mainnet';

/** USDC (FiatTokenV2) on Base mainnet. */
export const BASE_USDC: Address = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** USDC (FiatTokenV2) on Base Sepolia. */
export const BASE_SEPOLIA_USDC_ADDRESS: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** Coinbase's hosted testnet facilitator: free, no credentials, v1 + v2. */
export const TESTNET_FACILITATOR_URL = 'https://x402.org/facilitator';

/** Coinbase CDP's facilitator — the mainnet one, and it requires CDP keys. */
export const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

export const TESTNET: NetworkProfile = {
  name: 'testnet',
  network: 'base-sepolia',
  caip2: 'eip155:84532',
  chainId: 84532,
  viemChain: baseSepolia,
  usdc: BASE_SEPOLIA_USDC_ADDRESS,
  decimals: 6,
  eip712: { name: 'USDC', version: '2' },
  facilitatorUrl: TESTNET_FACILITATOR_URL,
  facilitatorAuth: 'none',
  defaultRpcUrl: 'https://sepolia.base.org',
  faucetUrl: 'https://faucet.circle.com',
  explorerTxUrl: (txHash) => `https://sepolia.basescan.org/tx/${txHash}`,
};

export const MAINNET: NetworkProfile = {
  name: 'mainnet',
  network: 'base',
  caip2: 'eip155:8453',
  chainId: 8453,
  viemChain: base,
  usdc: BASE_USDC,
  decimals: 6,
  // See NetworkProfile.eip712. `profiles.live.test.ts` reads name() and
  // version() off the real contract rather than trusting this line.
  eip712: { name: 'USD Coin', version: '2' },
  facilitatorUrl: CDP_FACILITATOR_URL,
  facilitatorAuth: 'cdp',
  defaultRpcUrl: 'https://mainnet.base.org',
  explorerTxUrl: (txHash) => `https://basescan.org/tx/${txHash}`,
};

export const PROFILES: Readonly<Record<ProfileName, NetworkProfile>> = {
  testnet: TESTNET,
  mainnet: MAINNET,
};

/**
 * Resolve a profile name, failing closed on anything else.
 *
 * Deliberately NOT defaulting an unknown string to testnet: a typo in
 * `REIN_NETWORK_PROFILE=mainet` that silently lands on testnet is a vendor
 * taking real requests and being paid in play money, and it would look like
 * everything worked. An empty/absent value is the caller's to default.
 */
export function parseProfileName(raw: string): ProfileName {
  const key = raw.trim().toLowerCase();
  if (key === 'testnet' || key === 'mainnet') return key;
  throw new RailsError(
    'unsupported_network',
    `unknown network profile "${raw}" (expected "testnet" or "mainnet")`,
  );
}

/** The profile for a name, parsed and resolved in one step. */
export function profileFor(raw: string): NetworkProfile {
  return PROFILES[parseProfileName(raw)];
}

/**
 * The profile whose network a 402 offer names, in either dialect, or
 * undefined for a network these rails do not pay on. Callers must fail closed.
 */
export function profileForNetwork(network: string): NetworkProfile | undefined {
  const key = network.toLowerCase();
  for (const profile of Object.values(PROFILES)) {
    if (key === profile.network || key === profile.caip2) return profile;
  }
  return undefined;
}
