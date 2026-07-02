import type { Account, Address, Chain, PublicClient, Transport, WalletClient } from 'viem';
import { keccak256, parseEventLogs, stringToBytes } from 'viem';
import { parseErc8004Id, type ReputationScore } from '@rein/core';
import { reputationRegistryAbi } from './abi.js';
import { Erc8004Error } from './errors.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  REPUTATION_REGISTRY_TESTNET,
  rethrowRead,
  type RegistryChainReader,
  type RegistryRef,
} from './registry.js';

/**
 * The ERC-8004 Reputation Registry write side: publish Rein's graph-derived
 * scores on-chain as feedback about an agent's on-chain identity.
 *
 * Contract facts this module is built on (verified against source, S19):
 * `giveFeedback` may be called by ANY address except the agent's owner or an
 * approved operator — so the publisher is a counterparty (a Rein gate/graph
 * operator scoring the agents it transacted with), never the agent itself.
 * Feedback indexes are 1-based per (agentId, clientAddress). `getSummary`
 * averages (WAD-normalized) non-revoked matching entries.
 */

/** The singleton Reputation Registry on Base Sepolia (same 0x8004B… everywhere). */
export const BASE_SEPOLIA_REPUTATION: RegistryRef = {
  chainId: BASE_SEPOLIA_CHAIN_ID,
  address: REPUTATION_REGISTRY_TESTNET,
};

/** Rein's tag1 convention: filters getSummary down to Rein-published scores. */
export const REIN_SCORE_TAG = 'rein-score';

const INT128_MAX = 2n ** 127n - 1n;

export interface FeedbackInput {
  /** The identity's tokenId (the spec's agentId). */
  agentId: bigint;
  /** Fixed-point value at `valueDecimals` (Rein scores: 0-100, decimals 0). */
  value: bigint;
  valueDecimals?: number;
  tag1?: string;
  tag2?: string;
  /** The evaluated service endpoint; empty = the agent overall. */
  endpoint?: string;
  /** Off-chain evidence JSON; data: URIs keep the demo infra-free. */
  feedbackURI?: string;
  /** keccak256 of the feedbackURI content (optional for content-addressed URIs). */
  feedbackHash?: `0x${string}`;
}

export interface PublishedFeedback {
  agentId: bigint;
  clientAddress: string;
  /** 1-based per (agentId, clientAddress). */
  feedbackIndex: bigint;
  txHash: string;
}

export interface FeedbackSummary {
  count: bigint;
  /** WAD-normalized average, scaled to `valueDecimals`. */
  value: bigint;
  valueDecimals: number;
}

export interface FeedbackEntry {
  value: bigint;
  valueDecimals: number;
  tag1: string;
  tag2: string;
  revoked: boolean;
}

export function validateFeedback(input: FeedbackInput): void {
  const decimals = input.valueDecimals ?? 0;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Erc8004Error('feedback_failed', `valueDecimals must be an integer 0-18, got ${decimals}`);
  }
  if (input.value > INT128_MAX || input.value < -INT128_MAX - 1n) {
    throw new Erc8004Error('feedback_failed', `value ${input.value} does not fit int128`);
  }
  if (input.feedbackHash !== undefined && !/^0x[0-9a-fA-F]{64}$/.test(input.feedbackHash)) {
    throw new Erc8004Error('feedback_failed', `feedbackHash must be bytes32 hex, got ${input.feedbackHash}`);
  }
}

const ZERO_HASH = `0x${'0'.repeat(64)}` as const;

/**
 * The write path: publish one feedback entry. Mirrors registerAgent's shape —
 * simulate -> write -> receipt -> decode the NewFeedback EVENT (authoritative;
 * filtered by registry address). The same retry warning applies: a
 * 'feedback_failed' can be a receipt-wait timeout with the tx still landing;
 * feedback is APPEND-ONLY, so a blind retry publishes a duplicate entry
 * (skewing getSummary), not a corrupt one.
 */
export async function giveFeedback(options: {
  publicClient: Pick<PublicClient, 'simulateContract' | 'waitForTransactionReceipt'>;
  walletClient: Pick<WalletClient<Transport, Chain, Account>, 'writeContract' | 'account'>;
  registry?: RegistryRef;
  input: FeedbackInput;
}): Promise<PublishedFeedback> {
  const registry = options.registry ?? BASE_SEPOLIA_REPUTATION;
  validateFeedback(options.input);
  const { agentId, value } = options.input;
  try {
    const { request } = await options.publicClient.simulateContract({
      address: registry.address as Address,
      abi: reputationRegistryAbi,
      functionName: 'giveFeedback',
      args: [
        agentId,
        value,
        options.input.valueDecimals ?? 0,
        options.input.tag1 ?? '',
        options.input.tag2 ?? '',
        options.input.endpoint ?? '',
        options.input.feedbackURI ?? '',
        options.input.feedbackHash ?? ZERO_HASH,
      ],
      account: options.walletClient.account,
    });
    const txHash = await options.walletClient.writeContract(request);
    const receipt = await options.publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status === 'reverted') {
      throw new Erc8004Error('feedback_failed', `giveFeedback() tx reverted: ${txHash}`);
    }
    const [event] = parseEventLogs({
      abi: reputationRegistryAbi,
      eventName: 'NewFeedback',
      logs: receipt.logs,
    }).filter((log) => log.address.toLowerCase() === registry.address.toLowerCase());
    if (!event) {
      throw new Erc8004Error('feedback_failed', `no NewFeedback event in tx ${txHash}`);
    }
    return {
      agentId: event.args.agentId,
      clientAddress: event.args.clientAddress,
      feedbackIndex: event.args.feedbackIndex,
      txHash,
    };
  } catch (err) {
    if (err instanceof Erc8004Error) throw err;
    throw new Erc8004Error('feedback_failed', `giveFeedback() failed: ${(err as Error).message}`);
  }
}

/** Every address that has published feedback about the agent. */
export async function feedbackClients(
  client: RegistryChainReader,
  options: { agentId: bigint; registry?: RegistryRef },
): Promise<readonly string[]> {
  const registry = options.registry ?? BASE_SEPOLIA_REPUTATION;
  return client.readContract({
    address: registry.address as Address,
    abi: reputationRegistryAbi,
    functionName: 'getClients',
    args: [options.agentId],
  });
}

/**
 * getSummary over the real registry. Filters: clients omitted = ALL known
 * clients, tags '' = any. LIVE-VERIFIED (S19): the deployed contract reverts
 * "clientAddresses required" on an empty list — unlike the repo's main-branch
 * source — so an omitted/empty filter is resolved through getClients(agentId)
 * first; an agent with no feedback at all short-circuits to zeros.
 */
export async function readSummary(
  client: RegistryChainReader,
  options: {
    agentId: bigint;
    clients?: readonly string[];
    tag1?: string;
    tag2?: string;
    registry?: RegistryRef;
  },
): Promise<FeedbackSummary> {
  const registry = options.registry ?? BASE_SEPOLIA_REPUTATION;
  let clients = options.clients;
  if (clients === undefined || clients.length === 0) {
    clients = await feedbackClients(client, { agentId: options.agentId, registry });
    if (clients.length === 0) return { count: 0n, value: 0n, valueDecimals: 0 };
  }
  const [count, value, valueDecimals] = await client.readContract({
    address: registry.address as Address,
    abi: reputationRegistryAbi,
    functionName: 'getSummary',
    args: [options.agentId, clients as Address[], options.tag1 ?? '', options.tag2 ?? ''],
  });
  return { count, value, valueDecimals };
}

/** One stored entry. Reverts (as 'feedback_failed') on an out-of-bounds index. */
export async function readFeedbackEntry(
  client: RegistryChainReader,
  options: { agentId: bigint; clientAddress: string; index: bigint; registry?: RegistryRef },
): Promise<FeedbackEntry> {
  const registry = options.registry ?? BASE_SEPOLIA_REPUTATION;
  try {
    const [value, valueDecimals, tag1, tag2, revoked] = await client.readContract({
      address: registry.address as Address,
      abi: reputationRegistryAbi,
      functionName: 'readFeedback',
      args: [options.agentId, options.clientAddress as Address, options.index],
    });
    return { value, valueDecimals, tag1, tag2, revoked };
  } catch (err) {
    rethrowRead(err, `readFeedback(${options.agentId}, ${options.index})`, 'feedback_failed');
  }
}

/** How many entries this client has published about the agent (0 = none). */
export async function lastFeedbackIndex(
  client: RegistryChainReader,
  options: { agentId: bigint; clientAddress: string; registry?: RegistryRef },
): Promise<bigint> {
  const registry = options.registry ?? BASE_SEPOLIA_REPUTATION;
  return client.readContract({
    address: registry.address as Address,
    abi: reputationRegistryAbi,
    functionName: 'getLastIndex',
    args: [options.agentId, options.clientAddress as Address],
  });
}

/**
 * Map a graph score onto the feedback wire: value = the 0-100 headline score
 * (decimals 0 — the spec's quality-rating convention), tag1 = the Rein filter
 * tag, tag2 = the confidence as an integer percentage. The score's SUBJECT
 * must already be erc8004-canonical (that is what links.ts makes true for
 * registered agents) — the tokenId is parsed straight out of it, so feedback
 * can never be published about a different identity than the evidence keys by.
 */
export function scoreToFeedback(
  score: ReputationScore,
  opts: {
    /** When given, the score's embedded registry ref must match (chain + address). */
    identity?: RegistryRef;
    endpoint?: string;
    feedbackURI?: string;
    feedbackHash?: `0x${string}`;
  } = {},
): FeedbackInput {
  if (score.subject.kind !== 'agent') {
    throw new Erc8004Error('bad_id', `only agent scores publish as ERC-8004 feedback (got ${score.subject.kind})`);
  }
  const ref = parseErc8004Id(score.subject.id);
  if (!ref) {
    throw new Erc8004Error('bad_id', `score subject is not erc8004-canonical: ${score.subject.id}`);
  }
  if (
    opts.identity &&
    (ref.chainId !== opts.identity.chainId ||
      ref.registry !== opts.identity.address.toLowerCase())
  ) {
    throw new Erc8004Error(
      'bad_id',
      `score subject ${score.subject.id} names a different registry than ${opts.identity.address} on chain ${opts.identity.chainId}`,
    );
  }
  return {
    agentId: ref.tokenId,
    value: BigInt(Math.round(score.score)),
    valueDecimals: 0,
    tag1: REIN_SCORE_TAG,
    tag2: `confidence-${Math.round(score.confidence * 100)}`,
    ...(opts.endpoint ? { endpoint: opts.endpoint } : {}),
    ...(opts.feedbackURI ? { feedbackURI: opts.feedbackURI } : {}),
    ...(opts.feedbackHash ? { feedbackHash: opts.feedbackHash } : {}),
  };
}

export interface FeedbackEvidence {
  /** The off-chain JSON document (spec-example shape + Rein's explanation). */
  doc: Record<string, unknown>;
  json: string;
  /** keccak256 of the exact json bytes — what goes on-chain as feedbackHash. */
  feedbackHash: `0x${string}`;
  /** data: URI carrying the json itself — content-addressed, no hosting needed. */
  dataUri: string;
}

/**
 * Build the off-chain evidence document for a score. Field names follow the
 * spec's feedbackURI example (agentRegistry/agentId/clientAddress/createdAt/
 * value/valueDecimals); Rein's component breakdown rides along under `rein`,
 * so anyone can recompute WHY the number is what it is. The data: URI form is
 * self-contained and self-verifying (hash the content, compare on-chain).
 */
export function feedbackEvidence(
  score: ReputationScore,
  opts: { clientAddress: string },
): FeedbackEvidence {
  const ref = parseErc8004Id(score.subject.id);
  if (!ref) {
    throw new Erc8004Error('bad_id', `score subject is not erc8004-canonical: ${score.subject.id}`);
  }
  const doc = {
    agentRegistry: `eip155:${ref.chainId}:${ref.registry}`,
    agentId: ref.tokenId.toString(),
    clientAddress: opts.clientAddress,
    createdAt: score.asOf.toISOString(),
    value: Math.round(score.score),
    valueDecimals: 0,
    rein: {
      components: score.components,
      confidence: score.confidence,
    },
  };
  const json = JSON.stringify(doc);
  return {
    doc,
    json,
    feedbackHash: keccak256(stringToBytes(json)),
    dataUri: `data:application/json;base64,${Buffer.from(json, 'utf8').toString('base64')}`,
  };
}

/**
 * The whole loop in one call: evidence doc -> hash -> data: URI ->
 * giveFeedback on-chain. Returns the published pointer AND the score with
 * `evidenceUri` filled in (core's ReputationScore field exists for exactly
 * this — a hash-anchored attestation, now actually anchored).
 */
export async function publishAgentScore(options: {
  publicClient: Pick<PublicClient, 'simulateContract' | 'waitForTransactionReceipt'>;
  walletClient: Pick<WalletClient<Transport, Chain, Account>, 'writeContract' | 'account'>;
  score: ReputationScore;
  registry?: RegistryRef;
  identity?: RegistryRef;
  endpoint?: string;
}): Promise<{ published: PublishedFeedback; score: ReputationScore; evidenceUri: string }> {
  const clientAddress = options.walletClient.account.address;
  const evidence = feedbackEvidence(options.score, { clientAddress });
  const input = scoreToFeedback(options.score, {
    identity: options.identity,
    endpoint: options.endpoint,
    feedbackURI: evidence.dataUri,
    feedbackHash: evidence.feedbackHash,
  });
  const published = await giveFeedback({
    publicClient: options.publicClient,
    walletClient: options.walletClient,
    registry: options.registry,
    input,
  });
  return {
    published,
    evidenceUri: evidence.dataUri,
    score: { ...options.score, evidenceUri: evidence.dataUri },
  };
}
