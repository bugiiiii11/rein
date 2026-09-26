import { compareDecimal, isValidDecimal, mulDecimal } from '@reinconsole/core';
import { atomicToDecimal } from '@reinconsole/sdk';
import { GateError } from './errors.js';

/**
 * Surge pricing — the profit guard (designed S77, built S79).
 *
 * A keyless facilitator bills the SELLER for each settlement (PayAI: gas plus
 * a 30% margin). At a cent-level list price that is fine on an ordinary day
 * and a loss on a congested one: measured on Base, a $0.01 sale ran under
 * water ~0.4% of the time, peaking near $1.77 a settlement. One such
 * settlement can eat a keyless seller's whole free allowance.
 *
 * So a gate with `surge` set quotes `max(list, multiplier x cost)` and
 * refuses to quote at all above `ceiling x list`. The multiplier (default 2)
 * is the cushion for the cost moving between quote and settle; the ceiling
 * (default 5) is where the vendor would rather say "come back later" than
 * sell at a price nobody expected. An oracle that cannot answer REFUSES
 * (503): it never falls back to the list price, which is exactly the price
 * that loses money when the oracle matters.
 *
 * The buyer side needs nothing new: a Rein policy's per-transaction cap
 * refuses a surge quote like any other over-cap price.
 */
export interface GateSurge {
  /**
   * The current cost of ONE settlement, as a decimal in the route's asset
   * units (USD for USDC). Throw when it is not known — the gate then refuses
   * with `price_unavailable`. See {@link settlementCostOracle}.
   */
  cost: () => Promise<string>;
  /** Quote at least this multiple of `cost`. Default "2". */
  multiplier?: string;
  /** Refuse (503 `price_ceiling`) instead of quoting above this multiple of the list price. Default "5". */
  ceiling?: string;
  /** Retry-After on both surge refusals. Default 60. */
  retryAfterSeconds?: number;
}

/** Resolved surge prices for one route, all in atomic units of its asset. */
export interface SurgeQuote {
  /** What a request is quoted now: max(list, multiplier x cost), rounded UP. */
  atomic: string;
  /** The most this route will ever quote: ceiling x list. */
  ceilingAtomic: string;
}

export function validateSurge(surge: GateSurge): void {
  for (const [name, value] of [
    ['multiplier', surge.multiplier],
    ['ceiling', surge.ceiling],
  ] as const) {
    if (value !== undefined && (!isValidDecimal(value) || compareDecimal(value, '1') < 0)) {
      throw new TypeError(`surge.${name} must be a decimal string >= 1, got ${JSON.stringify(value)}`);
    }
  }
  const { retryAfterSeconds } = surge;
  if (retryAfterSeconds !== undefined && !(Number.isInteger(retryAfterSeconds) && retryAfterSeconds >= 1)) {
    throw new TypeError(`surge.retryAfterSeconds must be a whole number >= 1, got ${retryAfterSeconds}`);
  }
}

/**
 * The price a route quotes right now. Throws `price_unavailable` when the
 * oracle fails or answers garbage, `price_ceiling` when the surge price is
 * above the ceiling. Both carry Retry-After: neither is the payer's fault.
 */
export async function surgeQuote(
  surge: GateSurge,
  listAtomic: string,
  decimals: number,
): Promise<SurgeQuote> {
  const retryAfterSeconds = surge.retryAfterSeconds ?? 60;
  let cost: string;
  try {
    cost = await surge.cost();
  } catch (err) {
    throw new GateError(
      'price_unavailable',
      `settlement cost unknown (${err instanceof Error ? err.message : String(err)}); not quoting a price that may lose money`,
      { retryAfterSeconds },
    );
  }
  if (typeof cost !== 'string' || !isValidDecimal(cost)) {
    throw new GateError('price_unavailable', `settlement cost oracle answered ${JSON.stringify(cost)}`, {
      retryAfterSeconds,
    });
  }
  const surgeAtomic = ceilAtomic(mulDecimal(cost, surge.multiplier ?? '2'), decimals);
  const ceilingAtomic = ceilAtomic(mulDecimal(atomicToDecimal(listAtomic, decimals), surge.ceiling ?? '5'), decimals);
  const atomic = BigInt(surgeAtomic) > BigInt(listAtomic) ? surgeAtomic : listAtomic;
  if (BigInt(atomic) > BigInt(ceilingAtomic)) {
    throw new GateError(
      'price_ceiling',
      `a settlement costs ${cost} right now, which would price this route above its ceiling of ${atomicToDecimal(ceilingAtomic, decimals)}; try again later`,
      { retryAfterSeconds },
    );
  }
  return { atomic, ceilingAtomic };
}

/** A decimal to atomic units, rounding any sub-atomic remainder UP (a seller never undercharges). */
export function ceilAtomic(decimal: string, decimals: number): string {
  const dot = decimal.indexOf('.');
  const intPart = dot === -1 ? decimal : decimal.slice(0, dot);
  const fracPart = dot === -1 ? '' : decimal.slice(dot + 1);
  const kept = BigInt(intPart + fracPart.slice(0, decimals).padEnd(decimals, '0'));
  const remainder = /[1-9]/.test(fracPart.slice(decimals)) ? 1n : 0n;
  return (kept + remainder).toString();
}

export interface SettlementCostOptions {
  /** JSON-RPC endpoint of the chain settlements land on, e.g. https://mainnet.base.org. */
  rpcUrl: string;
  /**
   * Chainlink ETH/USD aggregator on that chain. Base mainnet:
   * `0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70` ({@link BASE_ETH_USD_FEED}).
   */
  ethUsdFeed: string;
  /**
   * A facilitator's published per-settlement price list (PayAI's `/pricing`),
   * read for `network` (CAIP-2) and `transferMethod` (default `eip3009`).
   * The oracle answers the HIGHER of this and the gas estimate: the list is
   * what the facilitator says it bills, the gas estimate is what a spike does
   * before the list catches up.
   */
  pricing?: { url: string; network: string; transferMethod?: string };
  /** Gas one settlement burns. Default 90000 (an EIP-3009 transferWithAuthorization, with margin). */
  gasUnits?: number;
  /** The facilitator's margin over gas. Default "1.3" (PayAI's 3000 bps). */
  markup?: string;
  /** A feed answer older than this is refused. Default 3600 (Base's ETH/USD heartbeat is 1200 s). */
  maxFeedAgeSeconds?: number;
  /** How long an answer is reused. Default 15000 ms: short enough that a quote tracks a spike. */
  cacheMs?: number;
  fetch?: typeof fetch;
  now?: () => Date;
}

/** Chainlink's ETH/USD aggregator on Base mainnet (8 decimals). */
export const BASE_ETH_USD_FEED = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
/** PayAI's public per-settlement price list. */
export const PAYAI_PRICING_URL = 'https://facilitator.payai.network/pricing';

const SELECTOR_DECIMALS = '0x313ce567';
const SELECTOR_LATEST_ROUND = '0xfeaf968c';

/**
 * A {@link GateSurge.cost} for EVM settlements: `max(published rate, gasPrice
 * x gasUnits x ETH/USD x markup)`, cached for `cacheMs`. Every leg that is
 * configured must answer — a missing rate, a failed RPC, a stale or
 * non-positive feed answer all THROW, and the gate refuses rather than
 * quoting blind. Concurrent callers share one in-flight read.
 */
export function settlementCostOracle(options: SettlementCostOptions): () => Promise<string> {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const cacheMs = options.cacheMs ?? 15_000;
  const gasUnits = BigInt(options.gasUnits ?? 90_000);
  const markup = options.markup ?? '1.3';
  const maxFeedAgeSeconds = options.maxFeedAgeSeconds ?? 3600;
  let feedDecimals: number | undefined;
  let cached: { value: string; at: number } | undefined;
  let inFlight: Promise<string> | undefined;

  async function rpc(method: string, params: unknown[]): Promise<string> {
    const res = await doFetch(options.rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    if (!res.ok) throw new Error(`${method}: RPC answered HTTP ${res.status}`);
    const body = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (typeof body.result !== 'string' || !/^0x[0-9a-fA-F]*$/.test(body.result)) {
      throw new Error(`${method}: ${body.error?.message ?? 'no hex result'}`);
    }
    return body.result;
  }

  const call = (data: string) => rpc('eth_call', [{ to: options.ethUsdFeed, data }, 'latest']);

  async function gasCost(): Promise<string> {
    feedDecimals ??= Number(BigInt(await call(SELECTOR_DECIMALS)));
    const [gasPriceHex, round] = await Promise.all([rpc('eth_gasPrice', []), call(SELECTOR_LATEST_ROUND)]);
    // latestRoundData: (roundId, answer, startedAt, updatedAt, answeredInRound), 32 bytes each.
    const word = (i: number) => BigInt('0x' + round.slice(2 + i * 64, 2 + (i + 1) * 64));
    if (round.length < 2 + 5 * 64) throw new Error('ETH/USD feed returned a short answer');
    const answer = BigInt.asIntN(256, word(1));
    const updatedAt = Number(word(3));
    if (answer <= 0n) throw new Error(`ETH/USD feed answered ${answer}`);
    const age = Math.floor(now().getTime() / 1000) - updatedAt;
    if (age > maxFeedAgeSeconds) throw new Error(`ETH/USD feed is ${age}s old`);
    const wei = BigInt(gasPriceHex) * gasUnits;
    return mulDecimal(atomicToDecimal((wei * answer).toString(), 18 + feedDecimals), markup);
  }

  async function publishedRate(pricing: NonNullable<SettlementCostOptions['pricing']>): Promise<string> {
    const res = await doFetch(pricing.url);
    if (!res.ok) throw new Error(`pricing answered HTTP ${res.status}`);
    const body = (await res.json()) as { rates?: { network?: string; transferMethod?: string; usd?: unknown }[] };
    const method = pricing.transferMethod ?? 'eip3009';
    const rate = body.rates?.find((r) => r.network === pricing.network && r.transferMethod === method);
    if (!rate || typeof rate.usd !== 'string' || !isValidDecimal(rate.usd)) {
      throw new Error(`pricing lists no ${method} rate for ${pricing.network}`);
    }
    return rate.usd;
  }

  async function read(): Promise<string> {
    const legs = await Promise.all([
      gasCost(),
      ...(options.pricing ? [publishedRate(options.pricing)] : []),
    ]);
    return legs.reduce((a, b) => (compareDecimal(a, b) >= 0 ? a : b));
  }

  return () => {
    const at = now().getTime();
    if (cached && at - cached.at < cacheMs) return Promise.resolve(cached.value);
    inFlight ??= read()
      .then((value) => {
        cached = { value, at: now().getTime() };
        return value;
      })
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };
}
