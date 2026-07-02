import { describe, expect, it } from 'vitest';
import { keccak256, stringToBytes } from 'viem';
import type { ReputationScore } from '@rein/core';
import { ReputationGraph } from '@rein/graph';
import {
  feedbackEvidence,
  REIN_SCORE_TAG,
  scoreToFeedback,
  validateFeedback,
} from './feedback.js';
import { linkAgentFromRegistry } from './links.js';
import { MockIdentityRegistry, MockReputationRegistry } from './mock.js';

const NOW = new Date('2026-07-03T12:00:00Z');
const OWNER = '0xAgentOwner00000000000000000000000000000001';
const OPERATOR = '0x0perator0000000000000000000000000000000002';

function identityWithAgent() {
  const identity = new MockIdentityRegistry();
  const { tokenId, erc8004Id } = identity.register({ owner: OWNER, agentURI: 'https://a.test/reg.json' });
  return { identity, tokenId, erc8004Id };
}

function scoreFor(erc8004Id: string, over: Partial<ReputationScore> = {}): ReputationScore {
  return {
    subject: { kind: 'agent', id: erc8004Id },
    score: 87,
    components: {
      volume: 60,
      longevity: 80,
      disputeRate: 95,
      counterpartyQuality: 70,
      settlementReliability: 92,
    },
    confidence: 0.62,
    asOf: NOW,
    ...over,
  };
}

describe('scoreToFeedback', () => {
  it('maps the 0-100 score to value/decimals-0 with the Rein tags', () => {
    const { identity, erc8004Id, tokenId } = identityWithAgent();
    const input = scoreToFeedback(scoreFor(erc8004Id), { identity: identity.ref });
    expect(input).toMatchObject({
      agentId: tokenId,
      value: 87n,
      valueDecimals: 0,
      tag1: REIN_SCORE_TAG,
      tag2: 'confidence-62',
    });
  });

  it('refuses non-agent and non-canonical subjects', () => {
    const { erc8004Id } = identityWithAgent();
    expect(() =>
      scoreToFeedback(scoreFor(erc8004Id, { subject: { kind: 'vendor', id: 'api.v.test' } })),
    ).toThrow(/only agent scores/);
    expect(() =>
      scoreToFeedback(scoreFor(erc8004Id, { subject: { kind: 'agent', id: 'agt_01H' } })),
    ).toThrow(/not erc8004-canonical/);
  });

  it('refuses a subject naming a FOREIGN registry when identity is pinned', () => {
    const { identity, erc8004Id } = identityWithAgent();
    const foreign = new MockIdentityRegistry({ chainId: 84532 });
    expect(() => scoreToFeedback(scoreFor(erc8004Id), { identity: foreign.ref })).toThrow(
      /different registry/,
    );
    // Same registry passes.
    expect(() => scoreToFeedback(scoreFor(erc8004Id), { identity: identity.ref })).not.toThrow();
  });

  it('validateFeedback rejects out-of-range decimals and malformed hashes', () => {
    expect(() => validateFeedback({ agentId: 1n, value: 1n, valueDecimals: 19 })).toThrow(/0-18/);
    expect(() => validateFeedback({ agentId: 1n, value: 1n, valueDecimals: 0.5 })).toThrow(/0-18/);
    expect(() => validateFeedback({ agentId: 1n, value: 2n ** 127n })).toThrow(/int128/);
    expect(() =>
      validateFeedback({ agentId: 1n, value: 1n, feedbackHash: '0x1234' as never }),
    ).toThrow(/bytes32/);
  });
});

describe('feedbackEvidence', () => {
  it('builds a spec-shaped doc whose data: URI content matches the keccak hash', () => {
    const { erc8004Id } = identityWithAgent();
    const evidence = feedbackEvidence(scoreFor(erc8004Id), { clientAddress: OPERATOR });

    expect(evidence.doc).toMatchObject({
      agentId: '1',
      clientAddress: OPERATOR,
      createdAt: NOW.toISOString(),
      value: 87,
      valueDecimals: 0,
    });
    expect(evidence.doc['agentRegistry']).toMatch(/^eip155:8453:0x8004/);

    // Self-verifying: decode the URI, hash the content, compare.
    const [, base64] = evidence.dataUri.split(',');
    const decoded = Buffer.from(base64!, 'base64').toString('utf8');
    expect(decoded).toBe(evidence.json);
    expect(keccak256(stringToBytes(decoded))).toBe(evidence.feedbackHash);
  });
});

describe('MockReputationRegistry', () => {
  it('appends 1-based feedback per (agent, client) and reads it back', async () => {
    const { identity, tokenId } = identityWithAgent();
    const reputation = new MockReputationRegistry(identity);

    const first = await reputation.giveFeedback(OPERATOR, { agentId: tokenId, value: 80n });
    const second = await reputation.giveFeedback(OPERATOR, { agentId: tokenId, value: 90n, tag1: REIN_SCORE_TAG });
    expect(first.feedbackIndex).toBe(1n);
    expect(second.feedbackIndex).toBe(2n);
    expect(await reputation.getLastIndex(tokenId, OPERATOR)).toBe(2n);
    expect(await reputation.getLastIndex(tokenId, '0xNobody')).toBe(0n);

    expect(await reputation.readFeedback(tokenId, OPERATOR, 2n)).toMatchObject({
      value: 90n,
      tag1: REIN_SCORE_TAG,
      revoked: false,
    });
    await expect(reputation.readFeedback(tokenId, OPERATOR, 3n)).rejects.toThrow(/out of bounds/);
  });

  it('blocks self-feedback (owner) and unknown agents, like the chain', async () => {
    const { identity, tokenId } = identityWithAgent();
    const reputation = new MockReputationRegistry(identity);

    await expect(
      reputation.giveFeedback(OWNER.toUpperCase(), { agentId: tokenId, value: 100n }),
    ).rejects.toThrow(/Self-feedback not allowed/);
    await expect(reputation.giveFeedback(OPERATOR, { agentId: 999n, value: 1n })).rejects.toThrow(
      /no such agent/,
    );
  });

  it('getSummary averages non-revoked matches and honors tag + client filters', async () => {
    const { identity, tokenId } = identityWithAgent();
    const reputation = new MockReputationRegistry(identity);
    const otherClient = '0xAnotherClient000000000000000000000000000003';

    await reputation.giveFeedback(OPERATOR, { agentId: tokenId, value: 80n, tag1: REIN_SCORE_TAG });
    await reputation.giveFeedback(OPERATOR, { agentId: tokenId, value: 90n, tag1: REIN_SCORE_TAG });
    await reputation.giveFeedback(otherClient, { agentId: tokenId, value: 10n, tag1: 'starred' });

    // Tag filter: only the two Rein scores average.
    expect(await reputation.getSummary(tokenId, { tag1: REIN_SCORE_TAG })).toEqual({
      count: 2n,
      value: 85n,
      valueDecimals: 0,
    });
    // No filter: everything averages (80+90+10)/3 = 60.
    expect(await reputation.getSummary(tokenId)).toEqual({ count: 3n, value: 60n, valueDecimals: 0 });
    // Client filter.
    expect(await reputation.getSummary(tokenId, { clients: [otherClient.toUpperCase()] })).toEqual({
      count: 1n,
      value: 10n,
      valueDecimals: 0,
    });
    // Unknown agent: zeros, no revert (contract behavior).
    expect(await reputation.getSummary(999n)).toEqual({ count: 0n, value: 0n, valueDecimals: 0 });
  });

  it('WAD-normalizes mixed valueDecimals and reports the mode', async () => {
    const { identity, tokenId } = identityWithAgent();
    const reputation = new MockReputationRegistry(identity);

    // 0.9 at 1 decimal, 0.95 at 2 decimals, 0.91 at 2 decimals:
    // avg = (0.90 + 0.95 + 0.91)/3 = 0.92; mode decimals = 2 -> 92.
    await reputation.giveFeedback(OPERATOR, { agentId: tokenId, value: 9n, valueDecimals: 1 });
    await reputation.giveFeedback(OPERATOR, { agentId: tokenId, value: 95n, valueDecimals: 2 });
    await reputation.giveFeedback(OPERATOR, { agentId: tokenId, value: 91n, valueDecimals: 2 });

    expect(await reputation.getSummary(tokenId)).toEqual({ count: 3n, value: 92n, valueDecimals: 2 });
  });
});

describe('graph score -> on-chain feedback (the offline loop)', () => {
  it('a linked agent\'s graph score publishes and reads back at the same value', async () => {
    const identity = new MockIdentityRegistry();
    const reputation = new MockReputationRegistry(identity);
    const graph = new ReputationGraph({ now: () => NOW });

    // A registered agent with engine history folded into its eip155 identity.
    const wallet = '0xPayerWallet00000000000000000000000000000004';
    const { erc8004Id, tokenId } = identity.register({ owner: wallet });
    const linked = await linkAgentFromRegistry(graph, identity, {
      id: 'agt_local01',
      erc8004Id,
      wallets: [{ address: wallet }],
    });
    expect(linked.source).toBe('erc8004');

    const days = 14;
    for (let i = 0; i < 12; i += 1) {
      const at = new Date(NOW.getTime() - days * 86_400_000 + i * 3_600_000);
      graph.ingest({
        type: 'gate.settled',
        at,
        receipt: {
          id: `grc_feedback${i.toString().padStart(2, '0')}` as never,
          at,
          route: '/v1/*',
          resource: '/v1/q',
          method: 'GET',
          payer: wallet,
          payTo: '0xVendorTreasury0000000000000000000000000005',
          amount: '0.05',
          amountAtomic: '50000',
          asset: 'USDC',
          network: 'base',
          transaction: `0xt${i}`,
        },
      });
    }

    const score = graph.score(linked.canonical);
    expect(score).toBeDefined();

    // The vendor operator (NOT the agent's owner) publishes the score.
    const operator = '0xVendorTreasury0000000000000000000000000005';
    const evidence = feedbackEvidence(score!, { clientAddress: operator });
    const input = scoreToFeedback(score!, {
      identity: identity.ref,
      feedbackURI: evidence.dataUri,
      feedbackHash: evidence.feedbackHash,
    });
    const published = await reputation.giveFeedback(operator, input);
    expect(published).toMatchObject({ agentId: tokenId, feedbackIndex: 1n });

    const summary = await reputation.getSummary(tokenId, { tag1: REIN_SCORE_TAG });
    expect(summary.count).toBe(1n);
    expect(summary.value).toBe(BigInt(Math.round(score!.score)));
    expect(summary.valueDecimals).toBe(0);
  });
});
