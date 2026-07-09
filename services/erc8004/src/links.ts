import type { ReputationSubject } from '@reinconsole/core';
import { formatErc8004Id, parseErc8004Id } from '@reinconsole/core';
import { Erc8004Error } from './errors.js';
import type { IdentityRegistryReader } from './registry.js';

/**
 * Turning on-chain identity facts into reputation-graph link facts.
 *
 * Agents are ERC-8004-CANONICAL: a registered agent's evidence keys by its
 * on-chain identity (`eip155:{chainId}:{registry}/{tokenId}`), and the local
 * engine id plus every wallet fold in as aliases — one on-chain identity, one
 * reputation, portable across deployments; two local agents claiming the same
 * registration merge.
 *
 * Vendors stay HOST-canonical: hosts are the enforcement key (`syncVendors`
 * pushes host -> score into the engine; intents carry hosts), so a vendor's
 * on-chain identity and wallets fold INTO the host row, never the other way.
 *
 * TRUST NOTE: by default these helpers verify the identity's FACTS (owner,
 * agentWallet) but not the claimant's ENTITLEMENT — any doc can claim any
 * tokenId and its local history folds in. That is deliberate inside one trust
 * domain (an operator's own registry of agents; same-registration merge is a
 * feature). Multi-tenant deployments pass `entitlement: 'wallet'` to
 * linkAgentFromRegistry, which gates the claim on the doc actually holding
 * one of the identity's wallets (owner or agentWallet).
 */

/** Structurally satisfied by ReputationGraph — this package never imports @reinconsole/graph. */
export interface LinkSink {
  link(canonical: ReputationSubject, alias: ReputationSubject): void;
}

export interface LinkPair {
  canonical: ReputationSubject;
  alias: ReputationSubject;
}

/**
 * Dedupe key mirroring @reinconsole/graph's subjectKey EXACTLY — including the
 * eip155 parse->format branch, so a checksummed or zero-padded erc8004 id
 * dedupes the same way here as it merges there. Exported ONLY for the drift
 * canary test (links.drift.test.ts pins this against the real subjectKey);
 * runtime callers key subjects through @reinconsole/graph.
 */
export function keyOf(subject: ReputationSubject): string {
  if (subject.id.startsWith('eip155:')) {
    const ref = parseErc8004Id(subject.id);
    if (ref) return `${subject.kind}:${formatErc8004Id(ref)}`;
    // Malformed eip155-ish strings fall through to the plain rules below.
  }
  const id =
    subject.kind === 'vendor' || subject.id.startsWith('0x') || subject.id.startsWith('0X')
      ? subject.id.toLowerCase()
      : subject.id;
  return `${subject.kind}:${id}`;
}

function pairsFor(
  canonical: ReputationSubject,
  aliasIds: readonly string[],
  kind: ReputationSubject['kind'],
): LinkPair[] {
  const seen = new Set([keyOf(canonical)]);
  const pairs: LinkPair[] = [];
  for (const id of aliasIds) {
    const alias: ReputationSubject = { kind, id };
    const key = keyOf(alias);
    if (seen.has(key)) continue; // dedupe + drop self-pairs
    seen.add(key);
    pairs.push({ canonical, alias });
  }
  return pairs;
}

/**
 * PURE: the link pairs for a registered agent. Canonical = the parse->format
 * normalized erc8004 id (never hand-build the string — casing is load-bearing).
 * Throws Erc8004Error('bad_id') on an unparseable id.
 */
export function agentLinkPairs(facts: {
  erc8004Id: string;
  localId?: string;
  wallets?: readonly string[];
}): LinkPair[] {
  const ref = parseErc8004Id(facts.erc8004Id);
  if (!ref) throw new Erc8004Error('bad_id', `unparseable erc8004Id: ${facts.erc8004Id}`);
  const canonical: ReputationSubject = { kind: 'agent', id: formatErc8004Id(ref) };
  const aliases = [
    ...(facts.localId !== undefined ? [facts.localId] : []),
    ...(facts.wallets ?? []),
  ];
  return pairsFor(canonical, aliases, 'agent');
}

/** PURE: vendors keep the host canonical; identity + wallets fold into it. */
export function vendorLinkPairs(facts: {
  host: string;
  erc8004Id?: string;
  wallets?: readonly string[];
}): LinkPair[] {
  const canonical: ReputationSubject = { kind: 'vendor', id: facts.host };
  const ref = facts.erc8004Id !== undefined ? parseErc8004Id(facts.erc8004Id) : undefined;
  const aliases = [
    ...(ref ? [formatErc8004Id(ref)] : []),
    ...(facts.wallets ?? []),
  ];
  return pairsFor(canonical, aliases, 'vendor');
}

export interface LinkedIdentity {
  /** The subject the party's evidence now keys by. */
  canonical: ReputationSubject;
  /** How many alias pairs were asserted (0 = nothing to fold). */
  pairs: number;
  /** 'erc8004' when on-chain facts resolved; 'local' on the lenient fallback. */
  source: 'erc8004' | 'local';
  /**
   * Set (to false) only when `entitlement: 'wallet'` rejected the claim — the
   * one 'local' outcome that means "refused", not "no usable id". Callers in
   * multi-tenant deployments should surface it (a rejected claim is worth a
   * log line; a doc without an erc8004Id is not).
   */
  entitled?: boolean;
}

/** The parsed id must name THE registry we can query — foreign facts are not ours to assert. */
function refMatches(registry: IdentityRegistryReader, erc8004Id: string): boolean {
  const ref = parseErc8004Id(erc8004Id);
  return (
    ref !== undefined &&
    ref.chainId === registry.ref.chainId &&
    ref.registry === registry.ref.address.toLowerCase()
  );
}

/**
 * Resolve an agent's on-chain identity facts (ownerOf + agentWallet) and
 * assert the links. LENIENT by design — a world boot must not die on one
 * stale doc: a missing/unparseable/foreign-registry erc8004Id, or one the
 * registry does not know, falls back to today's local semantics (ULID
 * canonical, doc wallets as aliases). Network errors stay loud.
 *
 * `entitlement: 'wallet'` (multi-tenant claim gate): the merge only happens
 * when the doc HOLDS one of the identity's wallets — some doc wallet is the
 * on-chain owner or agentWallet (case-insensitive). A rejected claim falls
 * back to local semantics with `entitled: false`; the default 'open' keeps
 * today's single-trust-domain behavior.
 *
 * Callers MUST await this — the registry reads are async, and evidence
 * arriving before the alias map is populated mints a stray row (S15 lesson).
 */
export async function linkAgentFromRegistry(
  sink: LinkSink,
  registry: IdentityRegistryReader,
  agent: { id: string; erc8004Id?: string; wallets: readonly { address: string }[] },
  opts: { entitlement?: 'open' | 'wallet' } = {},
): Promise<LinkedIdentity> {
  const docWallets = agent.wallets.map((w) => w.address);
  const local = (entitled?: boolean): LinkedIdentity => {
    const canonical: ReputationSubject = { kind: 'agent', id: agent.id };
    const pairs = pairsFor(canonical, docWallets, 'agent');
    for (const p of pairs) sink.link(p.canonical, p.alias);
    return {
      canonical,
      pairs: pairs.length,
      source: 'local',
      ...(entitled !== undefined ? { entitled } : {}),
    };
  };

  if (agent.erc8004Id === undefined || !refMatches(registry, agent.erc8004Id)) return local();
  const ref = parseErc8004Id(agent.erc8004Id)!;
  // The one canonical, parse->format normalized — never the raw doc string.
  const canonical: ReputationSubject = { kind: 'agent', id: formatErc8004Id(ref) };

  let owner: string;
  let wallet: string | undefined;
  try {
    owner = await registry.ownerOf(ref.tokenId);
    wallet = await registry.agentWallet(ref.tokenId);
  } catch (err) {
    if (err instanceof Erc8004Error) return local(); // stale doc — lenient
    throw err;
  }

  if (opts.entitlement === 'wallet') {
    const identityWallets = new Set(
      [owner, ...(wallet !== undefined ? [wallet] : [])].map((w) => w.toLowerCase()),
    );
    if (!docWallets.some((w) => identityWallets.has(w.toLowerCase()))) return local(false);
  }

  const pairs = agentLinkPairs({
    erc8004Id: canonical.id,
    localId: agent.id,
    wallets: [...docWallets, owner, ...(wallet !== undefined ? [wallet] : [])],
  });
  for (const p of pairs) sink.link(p.canonical, p.alias);
  return { canonical, pairs: pairs.length, source: 'erc8004' };
}

/**
 * Vendor twin: fold the vendor's on-chain identity (id string, owner,
 * agentWallet — typically the treasury the gate pays to) into the HOST row.
 * Same leniency: unresolvable identity facts assert nothing.
 */
export async function linkVendorFromRegistry(
  sink: LinkSink,
  registry: IdentityRegistryReader,
  vendor: { host: string; erc8004Id: string },
): Promise<LinkedIdentity> {
  const canonical: ReputationSubject = { kind: 'vendor', id: vendor.host };
  if (!refMatches(registry, vendor.erc8004Id)) return { canonical, pairs: 0, source: 'local' };
  const tokenId = parseErc8004Id(vendor.erc8004Id)!.tokenId;

  let owner: string;
  let wallet: string | undefined;
  try {
    owner = await registry.ownerOf(tokenId);
    wallet = await registry.agentWallet(tokenId);
  } catch (err) {
    if (err instanceof Erc8004Error) return { canonical, pairs: 0, source: 'local' };
    throw err;
  }

  const pairs = vendorLinkPairs({
    host: vendor.host,
    erc8004Id: vendor.erc8004Id,
    wallets: [owner, ...(wallet !== undefined ? [wallet] : [])],
  });
  for (const p of pairs) sink.link(p.canonical, p.alias);
  return { canonical, pairs: pairs.length, source: 'erc8004' };
}
