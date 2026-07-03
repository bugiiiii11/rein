import { formatErc8004Id } from '@reinconsole/core';
import { Erc8004Error } from './errors.js';
import {
  validateFeedback,
  type FeedbackEntry,
  type FeedbackInput,
  type FeedbackSummary,
  type PublishedFeedback,
} from './feedback.js';
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

interface MockFeedbackRow extends FeedbackEntry {
  endpoint: string;
  feedbackURI: string;
  feedbackHash: string;
}

/**
 * In-memory twin of the ERC-8004 Reputation Registry, tied to a
 * MockIdentityRegistry the way the real contracts are tied (the identity
 * registry answers existence + the self-feedback restriction).
 *
 * Mirrors the real contract's observable behavior: 1-based feedbackIndex per
 * (agentId, clientAddress); giveFeedback reverts for a nonexistent agent
 * (via ownerOf) and for the agent's own owner ("Self-feedback not allowed");
 * getSummary WAD-averages non-revoked matching rows and scales the result to
 * the mode of the matched valueDecimals; readFeedback reverts out-of-bounds.
 * Documented divergences: no ERC-721 operator approvals (only the OWNER is
 * blocked from self-feedback); no revokeFeedback/appendResponse surface; and
 * getSummary here treats an empty client filter as ALL clients — matching
 * feedback.ts's readSummary HELPER semantics, not the raw deployed contract,
 * which live-reverts "clientAddresses required" on an empty list (S19).
 */
export class MockReputationRegistry {
  readonly ref: RegistryRef;

  /** agentId -> clientAddress (lowercased) -> rows (index i = feedbackIndex i+1). */
  private readonly rows = new Map<bigint, Map<string, MockFeedbackRow[]>>();
  private txCounter = 0;

  constructor(
    private readonly identity: MockIdentityRegistry,
    options: { address?: string } = {},
  ) {
    this.ref = {
      chainId: identity.ref.chainId,
      address: options.address ?? '0x8004000000000000000000000000000000000002',
    };
  }

  async giveFeedback(clientAddress: string, input: FeedbackInput): Promise<PublishedFeedback> {
    validateFeedback(input);
    // Existence + authorization ride the identity registry, like on-chain.
    const owner = await this.identity.ownerOf(input.agentId);
    if (owner.toLowerCase() === clientAddress.toLowerCase()) {
      throw new Erc8004Error('feedback_failed', 'Self-feedback not allowed');
    }
    const clients = this.rows.get(input.agentId) ?? new Map<string, MockFeedbackRow[]>();
    this.rows.set(input.agentId, clients);
    const key = clientAddress.toLowerCase();
    const list = clients.get(key) ?? [];
    clients.set(key, list);
    list.push({
      value: input.value,
      valueDecimals: input.valueDecimals ?? 0,
      tag1: input.tag1 ?? '',
      tag2: input.tag2 ?? '',
      endpoint: input.endpoint ?? '',
      feedbackURI: input.feedbackURI ?? '',
      feedbackHash: input.feedbackHash ?? `0x${'0'.repeat(64)}`,
      revoked: false,
    });
    this.txCounter += 1;
    return {
      agentId: input.agentId,
      clientAddress,
      feedbackIndex: BigInt(list.length),
      txHash: `0xmockfeedback${this.txCounter.toString(16).padStart(4, '0')}`,
    };
  }

  async getSummary(
    agentId: bigint,
    opts: { clients?: readonly string[]; tag1?: string; tag2?: string } = {},
  ): Promise<FeedbackSummary> {
    const clients = this.rows.get(agentId) ?? new Map<string, MockFeedbackRow[]>();
    const wanted = opts.clients?.map((c) => c.toLowerCase());
    const matched: MockFeedbackRow[] = [];
    for (const [client, list] of clients) {
      if (wanted && wanted.length > 0 && !wanted.includes(client)) continue;
      for (const row of list) {
        if (row.revoked) continue;
        if (opts.tag1 && row.tag1 !== opts.tag1) continue;
        if (opts.tag2 && row.tag2 !== opts.tag2) continue;
        matched.push(row);
      }
    }
    if (matched.length === 0) return { count: 0n, value: 0n, valueDecimals: 0 };

    // The real contract's math: normalize everything to 18 decimals (WAD),
    // average with integer division, then scale to the MODE of the matched
    // valueDecimals (ties resolve to the first seen — approximation).
    let sum = 0n;
    const decimalsSeen = new Map<number, number>();
    for (const row of matched) {
      sum += row.value * 10n ** BigInt(18 - row.valueDecimals);
      decimalsSeen.set(row.valueDecimals, (decimalsSeen.get(row.valueDecimals) ?? 0) + 1);
    }
    let mode = matched[0]!.valueDecimals;
    let best = 0;
    for (const [decimals, count] of decimalsSeen) {
      if (count > best) {
        best = count;
        mode = decimals;
      }
    }
    const avgWad = sum / BigInt(matched.length);
    return {
      count: BigInt(matched.length),
      value: avgWad / 10n ** BigInt(18 - mode),
      valueDecimals: mode,
    };
  }

  async readFeedback(
    agentId: bigint,
    clientAddress: string,
    feedbackIndex: bigint,
  ): Promise<FeedbackEntry> {
    const list = this.rows.get(agentId)?.get(clientAddress.toLowerCase()) ?? [];
    if (feedbackIndex < 1n || feedbackIndex > BigInt(list.length)) {
      throw new Erc8004Error(
        'feedback_failed',
        `readFeedback(${agentId}, ${feedbackIndex}): index out of bounds`,
      );
    }
    const { value, valueDecimals, tag1, tag2, revoked } = list[Number(feedbackIndex) - 1]!;
    return { value, valueDecimals, tag1, tag2, revoked };
  }

  async getLastIndex(agentId: bigint, clientAddress: string): Promise<bigint> {
    return BigInt(this.rows.get(agentId)?.get(clientAddress.toLowerCase())?.length ?? 0);
  }

  /** Every client that has published about the agent (lowercased here). */
  async getClients(agentId: bigint): Promise<readonly string[]> {
    return [...(this.rows.get(agentId)?.keys() ?? [])];
  }
}
