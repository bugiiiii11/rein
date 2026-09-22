import { z } from 'zod';
import { Chain, Asset, type TaskContext, type Vendor } from '@reinconsole/core';

/**
 * x402 wire shapes (spec v1), mock-first: these schemas are what Rein's mock
 * facilitator and tests speak today, and they track the published x402 spec so
 * real vendors parse identically when the live integration lands.
 */

/** One way to pay, as offered inside a 402 response body. */
export const PaymentRequirement = z.object({
  scheme: z.string(),
  network: z.string(),
  /** Amount in the asset's atomic units (e.g. "10000" = 0.01 USDC at 6 decimals). */
  maxAmountRequired: z.string().regex(/^\d+$/, 'atomic amount must be an integer string'),
  resource: z.string().optional(),
  description: z.string().optional(),
  mimeType: z.string().optional(),
  payTo: z.string().min(1),
  maxTimeoutSeconds: z.number().optional(),
  /** Token contract address — or, mock-first, a plain symbol like "USDC". */
  asset: z.string().min(1),
  extra: z.record(z.unknown()).optional(),
});
export type PaymentRequirement = z.infer<typeof PaymentRequirement>;

/** The full 402 body a paywalled vendor returns. */
export const PaymentRequired = z.object({
  x402Version: z.number(),
  accepts: z.array(PaymentRequirement).min(1),
  error: z.string().optional(),
});
export type PaymentRequired = z.infer<typeof PaymentRequired>;

/**
 * x402 network ids → the chains Rein governs. Testnets map to their mainnet.
 * Both v1 names ("base-sepolia") and v2 CAIP-2 ids ("eip155:84532") appear in
 * the wild, so the guard accepts either.
 */
const NETWORK_TO_CHAIN: Record<string, Chain> = {
  base: 'base',
  'base-sepolia': 'base',
  'eip155:8453': 'base',
  'eip155:84532': 'base',
  solana: 'solana',
  'solana-devnet': 'solana',
  polygon: 'polygon',
  'polygon-amoy': 'polygon',
  bnb: 'bnb',
  bsc: 'bnb',
};

/** Canonical stablecoin contract addresses (EVM keys lowercased). */
/**
 * Decimals per asset, from the token contracts -- NOT from the counterparty.
 *
 * `extra.decimals` arrives inside the vendor's own 402 challenge, and it used
 * to be what converted `maxAmountRequired` into the human amount policy is
 * evaluated against. The payer signs the RAW atomic value, so the vendor owned
 * the ratio between the number Rein judged and the number the wallet
 * authorized: quote 500000000 with `decimals: 12` and a 500 USDC charge is
 * evaluated as 0.0005, passes every cap and budget, and settles for 500.
 * Circle's USDC is 6 everywhere it is deployed; USDT and EURC are 6 on Base.
 */
const ASSET_DECIMALS: Record<Asset, number> = { USDC: 6, USDT: 6, EURC: 6 };

/** An EVM token address: only the address tables may name one. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const KNOWN_ASSET_ADDRESSES: Record<string, Asset> = {
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': 'USDC', // USDC on Base
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': 'USDC', // USDC on Base Sepolia
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC', // USDC on Solana
};

/**
 * Known v1 network names → CAIP-2. EVM entries are chain-id math; the Solana
 * ids are what the live facilitator advertises. Unknown names pass through
 * lowercased, so two spellings of an UNKNOWN network still compare equal.
 */
const CAIP2_ALIASES: Record<string, string> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  polygon: 'eip155:137',
  'polygon-amoy': 'eip155:80002',
  bnb: 'eip155:56',
  bsc: 'eip155:56',
  solana: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
};

/** The CAIP-2 id for a network name, or the lowercased name when unknown. */
export function caip2Of(network: string): string {
  const key = network.toLowerCase();
  return CAIP2_ALIASES[key] ?? key;
}

/** Do two network ids name the same chain, across the v1/CAIP-2 divide? */
export function sameNetwork(a: string, b: string): boolean {
  return caip2Of(a) === caip2Of(b);
}

export function networkToChain(network: string): Chain | undefined {
  return NETWORK_TO_CHAIN[network.toLowerCase()];
}

/**
 * Resolve a requirement's asset to a symbol Rein knows. Tries, in order: the
 * asset field as a literal symbol (mock-first), `extra.symbol`, then known
 * contract addresses (exact case for Solana, lowercased for EVM), then any
 * caller-supplied address map.
 */
export function resolveAsset(
  requirement: PaymentRequirement,
  extraAddresses: Record<string, Asset> = {},
): Asset | undefined {
  const direct = Asset.safeParse(requirement.asset.toUpperCase());
  if (direct.success) return direct.data;

  const known =
    extraAddresses[requirement.asset] ??
    extraAddresses[requirement.asset.toLowerCase()] ??
    KNOWN_ASSET_ADDRESSES[requirement.asset] ??
    KNOWN_ASSET_ADDRESSES[requirement.asset.toLowerCase()];
  if (known) return known;

  // `extra.symbol` is the counterparty's word for its own token, and it is
  // consulted LAST and never for an address. It used to come first, so any
  // EIP-3009 token could present itself as `USDC`: the engine evaluated the
  // agent's USDC caps and budgets, and the payer then signed a
  // TransferWithAuthorization against the attacker's chosen contract, spending
  // a balance no USDC policy was ever written about.
  if (EVM_ADDRESS.test(requirement.asset)) return undefined;
  const symbol = requirement.extra?.['symbol'];
  if (typeof symbol === 'string') {
    const fromExtra = Asset.safeParse(symbol.toUpperCase());
    if (fromExtra.success) return fromExtra.data;
  }

  return undefined;
}

/**
 * Convert an atomic-unit amount to a normalized decimal string without floats,
 * e.g. ("10000", 6) -> "0.01". Stablecoins Rein supports all use 6 decimals;
 * a requirement can override via `extra.decimals`.
 */
export function atomicToDecimal(atomic: string, decimals: number): string {
  if (!/^\d+$/.test(atomic)) throw new TypeError(`invalid atomic amount: ${atomic}`);
  if (decimals === 0) return atomic.replace(/^0+(?=\d)/, '');
  const digits = atomic.padStart(decimals + 1, '0');
  const intPart = digits.slice(0, digits.length - decimals).replace(/^0+(?=\d)/, '');
  const fracPart = digits.slice(digits.length - decimals).replace(/0+$/, '');
  return fracPart.length > 0 ? `${intPart}.${fracPart}` : intPart;
}

/**
 * The inverse of {@link atomicToDecimal}: a human-unit decimal string to atomic
 * units without floats, e.g. ("0.05", 6) -> "50000". Throws if the value has
 * more fraction digits than the asset carries (sub-atomic precision is a
 * pricing bug, not something to round silently).
 */
export function decimalToAtomic(decimal: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(decimal)) throw new TypeError(`invalid decimal amount: ${decimal}`);
  const dot = decimal.indexOf('.');
  const intPart = dot === -1 ? decimal : decimal.slice(0, dot);
  const fracPart = dot === -1 ? '' : decimal.slice(dot + 1);
  if (fracPart.length > decimals) {
    throw new TypeError(`amount ${decimal} has more than ${decimals} fraction digits`);
  }
  const atomic = intPart + fracPart.padEnd(decimals, '0');
  return atomic.replace(/^0+(?=\d)/, '');
}

/**
 * The decimals to read `maxAmountRequired` with.
 *
 * Pass the RESOLVED asset and the answer comes from `ASSET_DECIMALS` -- the
 * token's own precision, which the counterparty does not get a vote on. The
 * no-asset form is the legacy one and still honours `extra.decimals`; it must
 * not be used on any path that leads to a signature.
 */
export function requirementDecimals(requirement: PaymentRequirement, asset?: Asset): number {
  if (asset) return ASSET_DECIMALS[asset];
  const decimals = requirement.extra?.['decimals'];
  return typeof decimals === 'number' && Number.isInteger(decimals) && decimals >= 0 ? decimals : 6;
}

/**
 * Does the vendor's stated precision match the token's? A disagreement is not
 * an error to correct silently -- it is an offer whose amount we cannot agree
 * on, which makes it ungovernable, so `selectRequirement` skips it.
 */
export function decimalsAgree(requirement: PaymentRequirement, asset: Asset): boolean {
  const stated = requirement.extra?.['decimals'];
  if (stated === undefined) return true;
  return stated === ASSET_DECIMALS[asset];
}

/** A requirement the guard fully understood, mapped into Rein's domain. */
export interface ResolvedRequirement {
  requirement: PaymentRequirement;
  chain: Chain;
  asset: Asset;
  /** Human-unit decimal amount, e.g. "0.01". */
  amount: string;
}

/**
 * Pick the first offer the guard can govern: scheme `exact`, a network that
 * maps to a supported chain, an allowed network, and a resolvable asset.
 * Returns undefined when no offer qualifies — callers must treat that as
 * fail-closed.
 *
 * `networks` is the testnet/mainnet boundary, and it has to live HERE rather
 * than downstream of evaluate. `networkToChain` folds a testnet onto its
 * mainnet — `base-sepolia` and `base` both become `'base'` — because policy
 * is written about chains, not deployments. That is right for policy and
 * useless as a safety rail: the engine cannot tell a Sepolia offer from a
 * mainnet one, so a testnet agent handed a mainnet 402 would be allowed by
 * every policy it has and would then sign for real money. Filtering before
 * selection is what makes a network allow-list mean anything.
 */
export function selectRequirement(
  accepts: readonly PaymentRequirement[],
  extraAddresses: Record<string, Asset> = {},
  networks?: readonly string[],
): ResolvedRequirement | undefined {
  const allowed = networks?.map(caip2Of);
  for (const requirement of accepts) {
    if (requirement.scheme.toLowerCase() !== 'exact') continue;
    const chain = networkToChain(requirement.network);
    if (!chain) continue;
    if (allowed && !allowed.includes(caip2Of(requirement.network))) continue;
    const asset = resolveAsset(requirement, extraAddresses);
    if (!asset) continue;
    // Fail closed on a token whose precision the vendor states differently
    // from the contract: the amount policy would judge and the amount the
    // wallet would authorize are not the same number.
    if (!decimalsAgree(requirement, asset)) continue;
    const amount = atomicToDecimal(
      requirement.maxAmountRequired,
      requirementDecimals(requirement, asset),
    );
    return { requirement, chain, asset, amount };
  }
  return undefined;
}

/** What the guard submits to the policy engine (the `/v1/evaluate` shape). */
export interface IntentSubmission {
  agentId: string;
  vendor: Vendor;
  resource: string;
  amount: string;
  asset: Asset;
  chain: Chain;
  taskContext?: TaskContext;
}

/** Build the evaluate payload for a resolved offer on a given request URL. */
export function toIntentSubmission(
  resolved: ResolvedRequirement,
  url: string,
  agentId: string,
  taskContext: TaskContext | undefined,
): IntentSubmission {
  const parsed = new URL(url);
  return {
    agentId,
    vendor: {
      host: parsed.host,
      address: resolved.requirement.payTo,
    },
    resource: resolved.requirement.resource ?? parsed.pathname,
    amount: resolved.amount,
    asset: resolved.asset,
    chain: resolved.chain,
    taskContext,
  };
}
