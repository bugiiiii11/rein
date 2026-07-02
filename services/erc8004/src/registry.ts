import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from 'viem';
import {
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  parseEventLogs,
  zeroAddress,
} from 'viem';
import { formatErc8004Id } from '@rein/core';
import { identityRegistryAbi, reputationRegistryAbi } from './abi.js';
import { Erc8004Error } from './errors.js';

/**
 * ERC-8004 singleton deployments (verified live, session 17). The same
 * address serves Ethereum + Base per environment.
 */
export const IDENTITY_REGISTRY_MAINNET: Address = '0x8004A169FB4a3325136EB29fA0ceB6D2e539a432';
export const IDENTITY_REGISTRY_TESTNET: Address = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
export const REPUTATION_REGISTRY_TESTNET: Address = '0x8004B663056A597Dffe9eCcC1965A193B7388713';
export const BASE_SEPOLIA_CHAIN_ID = 84532;

/** Which registry contract (on which chain) a set of identity facts came from. */
export interface RegistryRef {
  chainId: number;
  address: string;
}

export const BASE_SEPOLIA_REGISTRY: RegistryRef = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  address: IDENTITY_REGISTRY_TESTNET,
};

/**
 * The slice of viem's PublicClient the reader needs. Offline code fakes the
 * domain-level `IdentityRegistryReader` port instead (MockIdentityRegistry) —
 * nothing in the repo ever fakes raw readContract calls.
 */
export type RegistryChainReader = Pick<PublicClient, 'readContract'>;

/**
 * The domain-level port the linking layer depends on: resolve on-chain
 * identity facts for one agentId. viem-backed against the real registry
 * (`identityRegistryReader`), in-memory for every offline path
 * (`MockIdentityRegistry`).
 */
export interface IdentityRegistryReader {
  readonly ref: RegistryRef;
  /** ERC-721 owner. Throws Erc8004Error('unknown_agent') for a nonexistent id. */
  ownerOf(tokenId: bigint): Promise<string>;
  /**
   * The EIP-712-verified payment wallet (`agentWallet` reserved metadata key;
   * auto-set to the owner at registration, cleared on transfer). `undefined`
   * when unset — the real contract returns the zero address and never reverts,
   * even for nonexistent agents.
   */
  agentWallet(tokenId: bigint): Promise<string | undefined>;
  /** The registration file URI (ERC-721 tokenURI). Throws 'unknown_agent' like ownerOf. */
  agentURI(tokenId: bigint): Promise<string>;
}

/**
 * Map a genuine on-chain REVERT (nonexistent token) to 'unknown_agent'; let
 * everything else stay loud. viem wraps EVERY readContract failure — network
 * timeouts, DNS errors, rate limits, calls to codeless addresses — in
 * ContractFunctionExecutionError, so the wrapper type alone cannot
 * discriminate: the revert-vs-network truth lives in the cause chain
 * (verified empirically in the S17 review — an unreachable RPC throws the
 * SAME wrapper with an HttpRequestError cause). Only a
 * ContractFunctionRevertedError in the chain means the contract answered.
 */
function rethrowRead(err: unknown, what: string): never {
  if (
    err instanceof ContractFunctionExecutionError &&
    err.walk((e) => e instanceof ContractFunctionRevertedError) !== null
  ) {
    throw new Erc8004Error('unknown_agent', `${what} reverted: ${err.shortMessage}`);
  }
  throw err; // network/RPC/config failures must never read as "not registered"
}

/** The real reader, over any viem PublicClient (or structural equivalent). */
export function identityRegistryReader(
  client: RegistryChainReader,
  ref: RegistryRef = BASE_SEPOLIA_REGISTRY,
): IdentityRegistryReader {
  const address = ref.address as Address;
  return {
    ref,
    async ownerOf(tokenId) {
      try {
        return await client.readContract({
          address,
          abi: identityRegistryAbi,
          functionName: 'ownerOf',
          args: [tokenId],
        });
      } catch (err) {
        rethrowRead(err, `ownerOf(${tokenId})`);
      }
    },
    async agentWallet(tokenId) {
      const wallet = await client.readContract({
        address,
        abi: identityRegistryAbi,
        functionName: 'getAgentWallet',
        args: [tokenId],
      });
      return wallet.toLowerCase() === zeroAddress ? undefined : wallet;
    },
    async agentURI(tokenId) {
      try {
        return await client.readContract({
          address,
          abi: identityRegistryAbi,
          functionName: 'tokenURI',
          args: [tokenId],
        });
      } catch (err) {
        rethrowRead(err, `tokenURI(${tokenId})`);
      }
    },
  };
}

/** Cross-check: the Reputation Registry names its Identity Registry on-chain. */
export async function getIdentityRegistryAddress(
  client: RegistryChainReader,
  reputationRegistry: Address = REPUTATION_REGISTRY_TESTNET,
): Promise<string> {
  return client.readContract({
    address: reputationRegistry,
    abi: reputationRegistryAbi,
    functionName: 'getIdentityRegistry',
  });
}

export interface RegisteredAgent {
  tokenId: bigint;
  /** Canonical id string — what goes on the Agent/Vendor doc. */
  erc8004Id: string;
  txHash: string;
  owner: string;
}

/**
 * The write path: mint an agent on the real registry. simulate -> write ->
 * wait for the receipt -> decode the `Registered` event (the EVENT is
 * authoritative — a simulate return value can go stale between simulation and
 * inclusion). The client params are the exact method slices used — naming the
 * full viem client types here trips chain-formatter variance (a baseSepolia-
 * typed client is not assignable to PublicClient<Transport, Chain>).
 *
 * RETRY WARNING: a 'registration_failed' can be a receipt-wait TIMEOUT — the
 * tx may still land later. Blindly retrying on that code can mint a SECOND
 * identity; callers persisting the id (the demo's .env) should check the
 * chain before re-registering.
 */
export async function registerAgent(options: {
  publicClient: Pick<PublicClient, 'simulateContract' | 'waitForTransactionReceipt'>;
  walletClient: Pick<WalletClient<Transport, Chain, Account>, 'writeContract' | 'account'>;
  ref?: RegistryRef;
  agentURI: string;
}): Promise<RegisteredAgent> {
  const ref = options.ref ?? BASE_SEPOLIA_REGISTRY;
  try {
    const { request } = await options.publicClient.simulateContract({
      address: ref.address as Address,
      abi: identityRegistryAbi,
      functionName: 'register',
      args: [options.agentURI],
      account: options.walletClient.account,
    });
    const txHash = await options.walletClient.writeContract(request);
    const receipt = await options.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === 'reverted') {
      throw new Erc8004Error('registration_failed', `register() tx reverted: ${txHash}`);
    }
    const [event] = parseEventLogs({
      abi: identityRegistryAbi,
      eventName: 'Registered',
      logs: receipt.logs,
    }).filter((log) => log.address.toLowerCase() === ref.address.toLowerCase());
    if (!event) {
      throw new Erc8004Error('registration_failed', `no Registered event in tx ${txHash}`);
    }
    return {
      tokenId: event.args.agentId,
      erc8004Id: formatErc8004Id({
        chainId: ref.chainId,
        registry: ref.address,
        tokenId: event.args.agentId,
      }),
      txHash,
      owner: event.args.owner,
    };
  } catch (err) {
    if (err instanceof Erc8004Error) throw err;
    throw new Erc8004Error('registration_failed', `register() failed: ${(err as Error).message}`);
  }
}
