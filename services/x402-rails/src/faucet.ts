import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  parseUnits,
  formatUnits,
  type Address,
  type Hex,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { TESTNET } from './profiles.js';

/**
 * The sandbox drip (Sprint 12): a few cents of Base Sepolia USDC from a
 * Rein-run faucet wallet to an agent wallet a stranger just generated, so
 * `npx @reinconsole/init` can reach a SETTLED payment with no faucet form and
 * no account.
 *
 * TESTNET ONLY, by construction: the profile is pinned here, not passed in.
 * There is no argument that turns this into a mainnet transfer -- a faucet
 * that could be pointed at real money is one env var away from giving it away.
 *
 * It returns once the transfer is SUBMITTED, not mined: Base Sepolia includes
 * it in seconds, and the caller (init) watches the balance anyway, so holding
 * an HTTP request open for a receipt would only make the sandbox slower.
 */
export interface UsdcFaucetOptions {
  /** The faucet wallet's key. It holds test USDC for the drips plus Sepolia ETH for gas. */
  privateKey: Hex;
  /** Defaults to the public Base Sepolia RPC, which rate-limits -- pass a keyed one. */
  rpcUrl?: string;
  /** Per drip, in USDC. Default 0.05 -- the starter policy's whole daily budget. */
  amount?: string;
}

export type UsdcFaucet = (to: Address) => Promise<{ txHash: string; amount: string }>;

export function createUsdcFaucet(options: UsdcFaucetOptions): UsdcFaucet {
  const account = privateKeyToAccount(options.privateKey);
  const transport = http(options.rpcUrl ?? TESTNET.defaultRpcUrl);
  const publicClient = createPublicClient({ chain: TESTNET.viemChain, transport });
  const wallet = createWalletClient({ account, chain: TESTNET.viemChain, transport });
  const amount = options.amount ?? '0.05';
  const units = parseUnits(amount, TESTNET.decimals);

  return async (to) => {
    const balance = await publicClient.readContract({
      address: TESTNET.usdc,
      abi: erc20Abi,
      functionName: 'balanceOf',
      args: [account.address],
    });
    if (balance < units) {
      throw new Error(
        `the sandbox faucet is dry (${formatUnits(balance, TESTNET.decimals)} USDC left); ` +
          `fund your wallet at ${TESTNET.faucetUrl}`,
      );
    }
    const txHash = await wallet.writeContract({
      address: TESTNET.usdc,
      abi: erc20Abi,
      functionName: 'transfer',
      args: [to, units],
    });
    return { txHash, amount };
  };
}

/** The faucet's own address, for the operator who has to fund it. */
export function faucetAddress(privateKey: Hex): Address {
  return privateKeyToAccount(privateKey).address;
}
