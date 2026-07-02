import { describe, expect, it } from 'vitest';
import type { Hex } from 'viem';
import { createPublicClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { baseSepolia } from 'viem/chains';
import { parseErc8004Id } from '@rein/core';
import { lastFeedbackIndex, readSummary, REIN_SCORE_TAG } from './feedback.js';
import {
  BASE_SEPOLIA_REGISTRY,
  IDENTITY_REGISTRY_TESTNET,
  getIdentityRegistryAddress,
  identityRegistryReader,
} from './registry.js';

/**
 * LIVE read-only tests against the real ERC-8004 registries on Base Sepolia.
 * Gated: they need network and — on this machine — NODE_EXTRA_CA_CERTS
 * pointing at the local CA pem. No gas is spent (reads only; the WRITE path
 * is exercised by `pnpm --filter @rein/demo demo:sepolia-8004`).
 *
 *   $env:NODE_EXTRA_CA_CERTS = "$HOME\.rein-dev-ca.pem"; $env:RUN_LIVE = "1"
 *   pnpm --filter @rein/erc8004 test
 *
 * The second test additionally needs REIN_SEPOLIA_ERC8004_ID (written to .env
 * by the demo) and REIN_SEPOLIA_PRIVATE_KEY exported into the process.
 */
const KEY = process.env['REIN_SEPOLIA_PRIVATE_KEY'] as Hex | undefined;
const ERC8004_ID = process.env['REIN_SEPOLIA_ERC8004_ID'];
const live = Boolean(process.env['RUN_LIVE']);

const client = () =>
  createPublicClient({
    chain: baseSepolia,
    transport: http(process.env['REIN_SEPOLIA_RPC_URL']),
  });

describe.skipIf(!live)('live: ERC-8004 registries on Base Sepolia', () => {
  it('the Reputation Registry names our Identity Registry (deployment self-consistency)', { timeout: 30_000 }, async () => {
    const identity = await getIdentityRegistryAddress(client());
    expect(identity.toLowerCase()).toBe(IDENTITY_REGISTRY_TESTNET.toLowerCase());
  });

  it.skipIf(KEY === undefined || ERC8004_ID === undefined)(
    'our registered agent resolves: ownerOf + agentWallet are our wallet',
    { timeout: 30_000 },
    async () => {
      const ref = parseErc8004Id(ERC8004_ID!);
      expect(ref, `unparseable REIN_SEPOLIA_ERC8004_ID: ${ERC8004_ID}`).toBeDefined();
      expect(ref!.chainId).toBe(BASE_SEPOLIA_REGISTRY.chainId);
      expect(ref!.registry).toBe(BASE_SEPOLIA_REGISTRY.address.toLowerCase());

      const ours = privateKeyToAccount(KEY!).address.toLowerCase();
      const reader = identityRegistryReader(client());
      expect((await reader.ownerOf(ref!.tokenId)).toLowerCase()).toBe(ours);
      expect((await reader.agentWallet(ref!.tokenId))?.toLowerCase()).toBe(ours);
      expect(await reader.agentURI(ref!.tokenId)).not.toBe('');
    },
  );

  it.skipIf(KEY === undefined || ERC8004_ID === undefined)(
    'the Reputation Registry answers feedback reads for our agent (S19 wire pin)',
    { timeout: 30_000 },
    async () => {
      const ref = parseErc8004Id(ERC8004_ID!)!;
      const ours = privateKeyToAccount(KEY!).address;

      // Shape pins, not value pins: zero feedback (fresh agent) and published
      // feedback (after demo:sepolia-8004's feedback beat) both must parse.
      const summary = await readSummary(client(), { agentId: ref.tokenId, tag1: REIN_SCORE_TAG });
      expect(summary.count).toBeGreaterThanOrEqual(0n);
      expect(summary.valueDecimals).toBeGreaterThanOrEqual(0);
      if (summary.count > 0n) {
        // Rein publishes 0-100 integer scores; the average must sit in range.
        expect(summary.value).toBeGreaterThanOrEqual(0n);
        expect(summary.value).toBeLessThanOrEqual(100n * 10n ** BigInt(summary.valueDecimals));
      }

      // Our OWN wallet cannot have published (self-feedback is banned on-chain).
      expect(await lastFeedbackIndex(client(), { agentId: ref.tokenId, clientAddress: ours })).toBe(
        0n,
      );
    },
  );
});
