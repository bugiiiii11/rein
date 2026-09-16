import { describe, it, expect } from 'vitest';
import { caip2Of } from '@reinconsole/sdk';
import { RailsError } from './errors.js';
import { chainIdForNetwork } from './networks.js';
import {
  MAINNET,
  PROFILES,
  TESTNET,
  parseProfileName,
  profileFor,
  profileForNetwork,
} from './profiles.js';

describe('network profiles', () => {
  /**
   * The load-bearing assertion in this file, and the reason profiles exist at
   * all. Base Sepolia's USDC is named `USDC`; Base mainnet's is named
   * `USD Coin`. payer.ts hardcoded the Sepolia spelling as its EIP-712 domain
   * fallback, which is invisible on testnet and produces a signature the
   * mainnet FiatTokenV2 rejects at settlement -- i.e. it fails only once the
   * money is real. profiles.live.test.ts reads both values off the actual
   * contract rather than letting this test agree with itself.
   */
  it('carries the mainnet EIP-712 domain, which differs from testnet', () => {
    expect(MAINNET.eip712).toEqual({ name: 'USD Coin', version: '2' });
    expect(TESTNET.eip712).toEqual({ name: 'USDC', version: '2' });
    expect(MAINNET.eip712.name).not.toBe(TESTNET.eip712.name);
  });

  it('agrees with the network tables the payer and the SDK already use', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(chainIdForNetwork(profile.network)).toBe(profile.chainId);
      expect(chainIdForNetwork(profile.caip2)).toBe(profile.chainId);
      expect(caip2Of(profile.network)).toBe(profile.caip2);
      expect(profile.viemChain.id).toBe(profile.chainId);
      expect(profile.decimals).toBe(6);
    }
  });

  it('names the two USDC deployments distinctly and as checksummed addresses', () => {
    expect(TESTNET.usdc).not.toBe(MAINNET.usdc);
    for (const profile of Object.values(PROFILES)) {
      expect(profile.usdc).toMatch(/^0x[0-9a-fA-F]{40}$/);
    }
  });

  it('marks only mainnet as needing facilitator credentials', () => {
    expect(TESTNET.facilitatorAuth).toBe('none');
    expect(MAINNET.facilitatorAuth).toBe('cdp');
    expect(TESTNET.faucetUrl).toBeDefined();
    // Not an oversight: there is no mainnet faucet, and a field pretending
    // otherwise would be read as "funds available here".
    expect(MAINNET.faucetUrl).toBeUndefined();
  });

  it('builds explorer links on the right explorer for each network', () => {
    expect(TESTNET.explorerTxUrl('0xabc')).toBe('https://sepolia.basescan.org/tx/0xabc');
    expect(MAINNET.explorerTxUrl('0xabc')).toBe('https://basescan.org/tx/0xabc');
  });

  describe('parseProfileName', () => {
    it('accepts both names, case- and whitespace-insensitively', () => {
      expect(parseProfileName('testnet')).toBe('testnet');
      expect(parseProfileName(' MAINNET ')).toBe('mainnet');
      expect(profileFor('mainnet')).toBe(MAINNET);
    });

    /**
     * Fail closed, do NOT default. A typo that silently lands on testnet is a
     * vendor taking real requests and being paid in play money, and every
     * signal an operator sees would say it worked.
     */
    it('refuses an unknown name rather than defaulting to testnet', () => {
      expect(() => parseProfileName('mainet')).toThrow(RailsError);
      expect(() => parseProfileName('mainet')).toThrow(/unknown network profile/);
      expect(() => parseProfileName('')).toThrow(RailsError);
    });
  });

  describe('profileForNetwork', () => {
    it('resolves both dialects of both networks', () => {
      expect(profileForNetwork('base-sepolia')).toBe(TESTNET);
      expect(profileForNetwork('eip155:84532')).toBe(TESTNET);
      expect(profileForNetwork('BASE')).toBe(MAINNET);
      expect(profileForNetwork('eip155:8453')).toBe(MAINNET);
    });

    it('returns undefined for a network these rails cannot pay on', () => {
      expect(profileForNetwork('solana')).toBeUndefined();
      expect(profileForNetwork('polygon')).toBeUndefined();
    });
  });
});
