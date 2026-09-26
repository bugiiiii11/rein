import { describe, it, expect } from 'vitest';
import type { PaymentRequirement } from '@reinconsole/sdk';
import { createGate, type GateOptions, type GateOutcome } from './gate.js';
import type { GateRails } from './rails.js';
import { ceilAtomic, settlementCostOracle, validateSurge, type GateSurge } from './surge.js';

const VENDOR = '0xVENDOR';
const WALLET = '0xAgentWallet01';
const URL_PING = 'https://api.vendor.test/v1/ping';

/** Rails that record the requirement each settle ran under. */
function recordingRails() {
  const settledUnder: PaymentRequirement[] = [];
  const rails: GateRails = {
    async verify() {},
    async settle(_header, requirement) {
      settledUnder.push(requirement);
      return { header: 'c2V0dGxlZA==', transaction: '0xtx', network: 'base' };
    },
  };
  return { rails, settledUnder };
}

function payment(value: string, intentId = value) {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from: WALLET, to: VENDOR, value, asset: 'USDC', intentId },
    }),
  ).toString('base64');
}

/** A cost oracle the test sets by hand; `undefined` makes it throw. */
function manualCost(initial: string | undefined) {
  let cost = initial;
  return {
    set: (next: string | undefined) => {
      cost = next;
    },
    fn: async () => {
      if (cost === undefined) throw new Error('oracle down');
      return cost;
    },
  };
}

function surgeGate(surge: GateSurge, options: Partial<GateOptions> = {}) {
  const { rails, settledUnder } = recordingRails();
  const gate = createGate({
    // $0.01 list, like the reference vendor's mainnet ping.
    routes: [{ path: '/v1/ping', price: '0.01' }],
    rails,
    payTo: VENDOR,
    network: 'base',
    asset: 'USDC',
    retry: { attempts: 0, backoffMs: 0 },
    surge,
    ...options,
  });
  return { gate, settledUnder };
}

const ping = (header: string | null) => ({ method: 'GET', url: URL_PING, payment: header });

function quoted(outcome: GateOutcome): string {
  if (outcome.kind !== 'quote') throw new Error(`expected a quote, got ${outcome.kind}`);
  return outcome.body.accepts[0]!.maxAmountRequired;
}

describe('surge pricing: what the gate quotes', () => {
  it('quotes the list price while 2x cost is below it', async () => {
    const { gate } = surgeGate({ cost: async () => '0.00231' });
    expect(quoted(await gate.handle(ping(null)))).toBe('10000');
  });

  it('quotes 2x cost, rounded UP to the asset, once that passes the list price', async () => {
    // 2 x 0.0120001 = 0.0240002 -> 24000.2 atomic -> 24001, never 24000.
    const { gate } = surgeGate({ cost: async () => '0.0120001' });
    const outcome = await gate.handle(ping(null));
    expect(quoted(outcome)).toBe('24001');
  });

  it('honours a custom multiplier', async () => {
    const { gate } = surgeGate({ cost: async () => '0.01', multiplier: '3' });
    expect(quoted(await gate.handle(ping(null)))).toBe('30000');
  });

  it('refuses 503 price_ceiling above ceiling x list, with Retry-After, rather than quote', async () => {
    // 2 x 0.03 = 0.06 > 5 x 0.01.
    const { gate } = surgeGate({ cost: async () => '0.03' });
    const outcome = await gate.handle(ping(null));
    expect(outcome).toMatchObject({
      kind: 'refused',
      status: 503,
      code: 'price_ceiling',
      retryAfterSeconds: 60,
      body: { code: 'price_ceiling', retriable: true },
    });
    expect(outcome).not.toHaveProperty('body.accepts');
  });

  it('quotes exactly AT the ceiling (the bound is inclusive)', async () => {
    const { gate } = surgeGate({ cost: async () => '0.025' });
    expect(quoted(await gate.handle(ping(null)))).toBe('50000');
  });

  it('refuses 503 price_unavailable when the oracle throws -- never the list price', async () => {
    const { gate } = surgeGate({ cost: async () => Promise.reject(new Error('rpc down')), retryAfterSeconds: 30 });
    const outcome = await gate.handle(ping(null));
    expect(outcome).toMatchObject({ kind: 'refused', status: 503, code: 'price_unavailable', retryAfterSeconds: 30 });
    if (outcome.kind === 'refused') expect(outcome.reason).toContain('rpc down');
  });

  it('refuses 503 price_unavailable when the oracle answers something that is not a decimal', async () => {
    const { gate } = surgeGate({ cost: async () => '-1' });
    expect(await gate.handle(ping(null))).toMatchObject({ status: 503, code: 'price_unavailable' });
  });

  it('refuses a payment too when the oracle is down, before its replay slot is burned', async () => {
    const cost = manualCost(undefined);
    const { gate, settledUnder } = surgeGate({ cost: cost.fn });
    const header = payment('10000');
    expect(await gate.handle(ping(header))).toMatchObject({ status: 503, code: 'price_unavailable' });
    // The same signed header is good once the oracle answers again.
    cost.set('0.001');
    expect((await gate.handle(ping(header))).kind).toBe('paid');
    expect(settledUnder).toHaveLength(1);
  });

  it('leaves a gate without surge on the exact list price (no oracle, exact match)', async () => {
    const { rails } = recordingRails();
    const gate = createGate({ routes: [{ path: '/v1/ping', price: '0.01' }], rails, payTo: VENDOR, network: 'base', asset: 'USDC' });
    expect(quoted(await gate.handle(ping(null)))).toBe('10000');
    expect(await gate.handle(ping(payment('20000')))).toMatchObject({ status: 402, code: 'amount_mismatch' });
  });
});

describe('surge pricing: which payments it accepts', () => {
  it('accepts a payment signed at an earlier, higher quote and settles it at its OWN value', async () => {
    const cost = manualCost('0.02'); // quote 0.04
    const { gate, settledUnder } = surgeGate({ cost: cost.fn });
    expect(quoted(await gate.handle(ping(null)))).toBe('40000');
    cost.set('0.001'); // the spike passes; the quote falls back to list
    const outcome = await gate.handle(ping(payment('40000')));
    expect(outcome.kind).toBe('paid');
    if (outcome.kind !== 'paid') return;
    expect(outcome.receipt).toMatchObject({ amount: '0.04', amountAtomic: '40000' });
    expect(settledUnder[0]!.maxAmountRequired).toBe('40000');
  });

  it('re-quotes (402) a payment below the CURRENT quote', async () => {
    const cost = manualCost('0.001');
    const { gate, settledUnder } = surgeGate({ cost: cost.fn });
    cost.set('0.02'); // the quote rose to 0.04 after the payer signed 0.01
    const outcome = await gate.handle(ping(payment('10000')));
    expect(outcome).toMatchObject({ kind: 'refused', status: 402, code: 'amount_mismatch' });
    if (outcome.kind === 'refused') {
      expect((outcome.body as { accepts: PaymentRequirement[] }).accepts[0]!.maxAmountRequired).toBe('40000');
    }
    expect(settledUnder).toHaveLength(0);
  });

  it('refuses a payment above the ceiling -- no quote that high was ever issued', async () => {
    const { gate } = surgeGate({ cost: async () => '0.001' });
    expect(await gate.handle(ping(payment('50001')))).toMatchObject({ status: 402, code: 'amount_mismatch' });
    expect((await gate.handle(ping(payment('50000')))).kind).toBe('paid');
  });

  it('counts the paid value, not the list price, against velocity caps', async () => {
    const { gate } = surgeGate({ cost: async () => '0.001' }, { velocity: { windowMs: 60_000, maxAmount: '0.05' } });
    expect((await gate.handle(ping(payment('40000', 'a')))).kind).toBe('paid');
    // 0.04 + 0.02 = 0.06 > 0.05 even though the list price is 0.01.
    expect(await gate.handle(ping(payment('20000', 'b')))).toMatchObject({ status: 429, code: 'velocity_exceeded' });
  });
});

describe('surge configuration', () => {
  it('rejects a multiplier or ceiling below 1, and a bad Retry-After', () => {
    const cost = async () => '0';
    expect(() => validateSurge({ cost, multiplier: '0.5' })).toThrow(/multiplier/);
    expect(() => validateSurge({ cost, ceiling: 'x' })).toThrow(/ceiling/);
    expect(() => validateSurge({ cost, retryAfterSeconds: 0 })).toThrow(/retryAfterSeconds/);
    expect(() => surgeGate({ cost, multiplier: '0.9' })).toThrow(/multiplier/);
  });

  it('ceilAtomic rounds a sub-atomic remainder up and nothing else', () => {
    expect(ceilAtomic('0.01', 6)).toBe('10000');
    expect(ceilAtomic('0.0100001', 6)).toBe('10001');
    expect(ceilAtomic('0.0100000000', 6)).toBe('10000');
    expect(ceilAtomic('3', 6)).toBe('3000000');
    expect(ceilAtomic('0.0000001', 6)).toBe('1');
  });
});

// ── settlementCostOracle ────────────────────────────────────────────────────

const RPC = 'https://rpc.test';
const FEED = '0xFEED';
const PRICING = 'https://facilitator.test/pricing';
const NOW_S = 1_800_000_000;
const hexWord = (n: bigint) => (BigInt.asUintN(256, n)).toString(16).padStart(64, '0');

interface ChainState {
  gasPriceWei: bigint;
  answer: bigint;
  updatedAt: number;
  rpcDown?: boolean;
  rates?: unknown;
}

function fakeChain(state: ChainState) {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === PRICING) {
      calls.push('pricing');
      return Response.json({ rates: state.rates });
    }
    if (state.rpcDown) return new Response('bad gateway', { status: 502 });
    const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: { data: string }[] };
    calls.push(method === 'eth_call' ? params[0]!.data : method);
    if (method === 'eth_gasPrice') return Response.json({ result: '0x' + state.gasPriceWei.toString(16) });
    if (params[0]!.data === '0x313ce567') return Response.json({ result: '0x' + hexWord(8n) });
    const round = [1n, state.answer, BigInt(state.updatedAt), BigInt(state.updatedAt), 1n].map(hexWord).join('');
    return Response.json({ result: '0x' + round });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const BASE_RATES = [
  { network: 'eip155:8453', scheme: 'exact', transferMethod: 'permit2', usd: '0.00218' },
  { network: 'eip155:8453', scheme: 'exact', transferMethod: 'eip3009', usd: '0.00231' },
];

describe('settlementCostOracle', () => {
  // The S79 live reading: 0.006 gwei, ETH at $2695, 90k gas, 1.3 markup.
  const live: ChainState = { gasPriceWei: 6_000_000n, answer: 269_500_000_000n, updatedAt: NOW_S - 60, rates: BASE_RATES };

  function oracle(state: ChainState, extra: { pricing?: boolean; cacheMs?: number; nowMs?: () => number } = {}) {
    const chain = fakeChain(state);
    const cost = settlementCostOracle({
      rpcUrl: RPC,
      ethUsdFeed: FEED,
      ...(extra.pricing === false ? {} : { pricing: { url: PRICING, network: 'eip155:8453' } }),
      fetch: chain.fetchImpl,
      now: () => new Date(extra.nowMs?.() ?? NOW_S * 1000),
      ...(extra.cacheMs !== undefined ? { cacheMs: extra.cacheMs } : {}),
    });
    return { cost, calls: chain.calls };
  }

  it('computes gas x price x ETH/USD x markup exactly', async () => {
    // 90000 * 6e6 wei = 5.4e11 wei = 5.4e-7 ETH; x 2695 = 0.00145530; x 1.3 = 0.00189189.
    const { cost } = oracle(live, { pricing: false });
    expect(await cost()).toBe('0.00189189');
  });

  it('answers the HIGHER of the gas estimate and the published eip3009 rate', async () => {
    expect(await oracle(live).cost()).toBe('0.00231');
    const spike = { ...live, gasPriceWei: 6_000_000_000n }; // 1000x: a congestion day
    expect(await oracle(spike).cost()).toBe('1.89189');
  });

  it('throws on a stale feed, a non-positive answer, a dead RPC, or a missing rate', async () => {
    await expect(oracle({ ...live, updatedAt: NOW_S - 3601 }).cost()).rejects.toThrow(/3601s old/);
    await expect(oracle({ ...live, answer: -1n }).cost()).rejects.toThrow(/answered -1/);
    await expect(oracle({ ...live, answer: 0n }).cost()).rejects.toThrow(/answered 0/);
    await expect(oracle({ ...live, rpcDown: true }).cost()).rejects.toThrow(/HTTP 502/);
    await expect(oracle({ ...live, rates: [BASE_RATES[0]] }).cost()).rejects.toThrow(/no eip3009 rate/);
    await expect(oracle({ ...live, rates: undefined }).cost()).rejects.toThrow(/no eip3009 rate/);
  });

  it('caches an answer for cacheMs, shares one in-flight read, and never caches a failure', async () => {
    let t = NOW_S * 1000;
    const state = { ...live };
    const { cost, calls } = oracle(state, { nowMs: () => t, cacheMs: 15_000 });
    const [a, b] = await Promise.all([cost(), cost()]);
    expect(a).toBe(b);
    const gasReads = () => calls.filter((c) => c === 'eth_gasPrice').length;
    expect(gasReads()).toBe(1);
    t += 14_999;
    await cost();
    expect(gasReads()).toBe(1);
    t += 1;
    state.rpcDown = true;
    await expect(cost()).rejects.toThrow();
    state.rpcDown = false;
    await cost();
    expect(gasReads()).toBe(2);
    // Feed decimals are read once for the oracle's lifetime.
    expect(calls.filter((c) => c === '0x313ce567')).toHaveLength(1);
  });

  it('drives a surge gate end to end: a 1000x gas spike prices the ping above its ceiling', async () => {
    const state = { ...live };
    const { gate } = surgeGate({ cost: oracle(state, { cacheMs: 0 }).cost });
    expect(quoted(await gate.handle(ping(null)))).toBe('10000');
    state.gasPriceWei = 6_000_000_000n;
    expect(await gate.handle(ping(null))).toMatchObject({ status: 503, code: 'price_ceiling' });
  });
});
