import { formatErc8004Id } from '@rein/core';
import { Erc8004Error } from './errors.js';
import type { IdentityRegistryReader, RegistryRef } from './registry.js';

/**
 * In-memory twin of the ERC-8004 Identity Registry — the offline counterpart
 * of `identityRegistryReader`, for demos, tests, and the console world.
 *
 * Mirrors the real contract's observable behavior: sequential tokenIds from 1,
 * `agentWallet` auto-set to the owner at registration (the reserved-key rule),
 * `ownerOf`/`agentURI` throw for nonexistent agents while `agentWallet`
 * returns undefined (the real read never reverts). One documented divergence:
 * `setAgentWallet` skips the EIP-712/ERC-1271 signature check and trusts the
 * caller — mock custody, mock proofs.
 *
 * The default ref is a FAKE address on Base's chain id: a mock must not claim
 * facts about the real deployment.
 */
export class MockIdentityRegistry implements IdentityRegistryReader {
  readonly ref: RegistryRef;

  private readonly agents = new Map<
    bigint,
    { owner: string; agentWallet?: string; agentURI?: string }
  >();
  private nextId = 1n;

  constructor(options: { chainId?: number; address?: string } = {}) {
    this.ref = {
      chainId: options.chainId ?? 8453,
      address: options.address ?? '0x8004000000000000000000000000000000000001',
    };
  }

  /** ERC-721-ish mint. agentWallet starts as the owner, per the spec. */
  register(input: { owner: string; agentURI?: string }): { tokenId: bigint; erc8004Id: string } {
    const tokenId = this.nextId++;
    this.agents.set(tokenId, {
      owner: input.owner,
      agentWallet: input.owner,
      ...(input.agentURI !== undefined ? { agentURI: input.agentURI } : {}),
    });
    return { tokenId, erc8004Id: this.idOf(tokenId) };
  }

  /** Rotate the verified payment wallet. DIVERGENCE: no signature verification. */
  setAgentWallet(tokenId: bigint, wallet: string): void {
    const agent = this.agents.get(tokenId);
    if (!agent) throw new Erc8004Error('unknown_agent', `setAgentWallet(${tokenId}): no such agent`);
    agent.agentWallet = wallet;
  }

  /**
   * Hydration primitive: reinsert a known registration verbatim (world boot
   * rebuilding "the chain" from persisted agent docs). Keeps minted ids stable
   * across restarts — the next register() mints past the highest loaded id.
   */
  load(record: { tokenId: bigint; owner: string; agentWallet?: string; agentURI?: string }): void {
    this.agents.set(record.tokenId, {
      owner: record.owner,
      ...(record.agentWallet !== undefined ? { agentWallet: record.agentWallet } : {}),
      ...(record.agentURI !== undefined ? { agentURI: record.agentURI } : {}),
    });
    if (record.tokenId >= this.nextId) this.nextId = record.tokenId + 1n;
  }

  /** The canonical id string this mock would put on a doc for `tokenId`. */
  idOf(tokenId: bigint): string {
    return formatErc8004Id({
      chainId: this.ref.chainId,
      registry: this.ref.address,
      tokenId,
    });
  }

  async ownerOf(tokenId: bigint): Promise<string> {
    const agent = this.agents.get(tokenId);
    if (!agent) throw new Erc8004Error('unknown_agent', `ownerOf(${tokenId}): no such agent`);
    return agent.owner;
  }

  async agentWallet(tokenId: bigint): Promise<string | undefined> {
    // Mirror the real reader's zero-address rule: setAgentWallet(zero) — the
    // natural "clear" gesture, and what a token transfer does on the real
    // contract — must read back as undefined, not as a shared zero sentinel
    // that could cross-link two cleared agents.
    const wallet = this.agents.get(tokenId)?.agentWallet;
    return wallet !== undefined && /^0x0{40}$/.test(wallet) ? undefined : wallet;
  }

  async agentURI(tokenId: bigint): Promise<string> {
    const agent = this.agents.get(tokenId);
    if (!agent) throw new Erc8004Error('unknown_agent', `agentURI(${tokenId}): no such agent`);
    return agent.agentURI ?? '';
  }
}
