import { describe, it, expect } from 'vitest';
import { getAddress } from 'viem';
import { createProfileFacilitator } from './cdp.js';
import { MAINNET } from './profiles.js';
import { createChainClient } from './wallet.js';

/**
 * READ-ONLY probes against Base MAINNET. No key, no payment, no write — these
 * only read public state, which is why they are safe to run at all.
 *
 * Gated separately from RUN_LIVE because RUN_LIVE means Sepolia, and someone
 * turning on the testnet suite should not silently start talking to mainnet:
 *
 *   $env:RUN_LIVE_MAINNET = "1"; pnpm --filter @reinconsole/x402-rails test
 *
 * Their job is to stop profiles.test.ts from being a tautology. A unit test
 * asserting MAINNET.eip712.name === 'USD Coin' only proves the file agrees
 * with itself; if the constant is WRONG, every unit test still passes and the
 * failure shows up as a rejected settlement the first time real money moves.
 * These read the truth off the chain.
 */
const live = Boolean(process.env['RUN_LIVE_MAINNET']);

const erc20MetaAbi = [
  { name: 'name', type: 'function', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    name: 'version',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'string' }],
  },
  {
    name: 'decimals',
    type: 'function',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const;

describe.skipIf(!live)('live: Base mainnet profile', () => {
  it('matches the EIP-712 domain the real USDC contract verifies against', async () => {
    const client = createChainClient(MAINNET, process.env['REIN_MAINNET_RPC_URL']);

    const [name, version, decimals] = await Promise.all([
      client.readContract({ address: MAINNET.usdc, abi: erc20MetaAbi, functionName: 'name' }),
      client.readContract({ address: MAINNET.usdc, abi: erc20MetaAbi, functionName: 'version' }),
      client.readContract({ address: MAINNET.usdc, abi: erc20MetaAbi, functionName: 'decimals' }),
    ]);

    // If this fails, every mainnet payment this repo signs is invalid.
    expect(name).toBe(MAINNET.eip712.name);
    expect(version).toBe(MAINNET.eip712.version);
    expect(decimals).toBe(MAINNET.decimals);
  });

  it('is the checksummed address of a contract that actually exists', async () => {
    const client = createChainClient(MAINNET, process.env['REIN_MAINNET_RPC_URL']);
    expect(getAddress(MAINNET.usdc)).toBe(MAINNET.usdc);
    const code = await client.getCode({ address: MAINNET.usdc });
    expect(code).toBeDefined();
    expect(code).not.toBe('0x');
  });

  it('reaches a chain that agrees with the profile chain id', async () => {
    const client = createChainClient(MAINNET, process.env['REIN_MAINNET_RPC_URL']);
    expect(await client.getChainId()).toBe(MAINNET.chainId);
  });

  /**
   * The CDP facilitator's /supported, which needs credentials. Skipped
   * without them rather than failed: the point of the other probes is that
   * they need nothing but a public RPC.
   */
  const cdpId = process.env['REIN_CDP_API_KEY_ID'];
  const cdpSecret = process.env['REIN_CDP_API_KEY_SECRET'];
  it.skipIf(!cdpId || !cdpSecret)(
    'advertises exact on base via the CDP facilitator',
    { timeout: 30_000 },
    async () => {
      const facilitator = createProfileFacilitator(MAINNET, {
        cdp: { apiKeyId: cdpId as string, apiKeySecret: cdpSecret as string },
      });
      const kinds = (await facilitator.supported()) as {
        kinds?: { scheme?: string; network?: string }[];
      };
      expect(kinds.kinds?.some((k) => k.scheme === 'exact')).toBe(true);
    },
  );
});
