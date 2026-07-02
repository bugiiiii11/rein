import { describe, it, expect } from 'vitest';
import type { ReinEvent } from '@rein/core';
import { GateError } from './errors.js';
import { createGate, type GateOptions, type GateOutcome } from './gate.js';
import {
  facilitatorClientRails,
  RailsUnreachableError,
  type FacilitatorClientLike,
  type GateRails,
} from './rails.js';
import { AttemptWindow, validateVelocity } from './velocity.js';

const VENDOR = '0xVENDOR';
const WALLET = '0xAgentWallet01';
const URL_ANSWER = 'https://api.vendor.test/api/answer';
const URL_DAI = 'https://api.vendor.test/api/dai';

function stubRails(overrides: Partial<GateRails> = {}): GateRails {
  return {
    async verify() {},
    async settle() {
      return { header: 'c2V0dGxlZA==', transaction: '0xtx', network: 'base' };
    },
    ...overrides,
  };
}

/** A mock-shape X-PAYMENT header; vary `intentId` to get distinct payments. */
function payment(overrides: Record<string, unknown> = {}) {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from: WALLET, to: VENDOR, value: '50000', asset: 'USDC', ...overrides },
    }),
  ).toString('base64');
}

/** Deterministic injectable clock. */
function clock(startMs = 1_000_000_000) {
  let t = startMs;
  return {
    now: () => new Date(t),
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function gateWith(options: Partial<GateOptions> = {}) {
  const events: ReinEvent[] = [];
  const gate = createGate({
    routes: [
      { path: '/api/dai', price: '0.05', asset: 'DAI' },
      { path: '/api/answer', price: '0.05' },
    ],
    rails: stubRails(),
    payTo: VENDOR,
    network: 'base',
    asset: 'USDC',
    retry: { attempts: 2, backoffMs: 0 },
    ...options,
  });
  gate.onEvent((e) => events.push(e));
  return { gate, events };
}

async function refusal(outcomePromise: Promise<GateOutcome>) {
  const outcome = await outcomePromise;
  if (outcome.kind !== 'refused') throw new Error(`expected refused, got ${outcome.kind}`);
  return outcome;
}

const answer = (header: string | null) => ({ method: 'GET', url: URL_ANSWER, payment: header });

describe('velocity: presentation rate limit (maxAttempts)', () => {
  it('refuses the presentation over the cap with 429 + Retry-After, then admits after the window', async () => {
    const c = clock();
    const { gate, events } = gateWith({
      now: c.now,
      velocity: { windowMs: 10_000, maxAttempts: 2 },
    });
    expect((await gate.handle(answer(payment({ intentId: 'a' })))).kind).toBe('paid');
    expect((await gate.handle(answer(payment({ intentId: 'b' })))).kind).toBe('paid');

    const third = payment({ intentId: 'c' });
    const outcome = await refusal(gate.handle(answer(third)));
    expect(outcome).toMatchObject({ status: 429, code: 'rate_limited', retryAfterSeconds: 10 });
    expect(outcome.body).toMatchObject({ error: 'refused', code: 'rate_limited', retryAfterSeconds: 10 });
    expect(events.at(-1)).toMatchObject({ type: 'gate.refused', code: 'rate_limited', payer: WALLET });

    // The refusal happened BEFORE the replay burn: the same header clears later.
    c.advance(10_001);
    expect((await gate.handle(answer(third))).kind).toBe('paid');
  });

  it('counts refused presentations too — a mismatch hammer gets rate limited', async () => {
    const c = clock();
    const { gate } = gateWith({ now: c.now, velocity: { windowMs: 10_000, maxAttempts: 2 } });
    const bad = (id: string) => payment({ value: '1', intentId: id });
    expect((await refusal(gate.handle(answer(bad('m1'))))).code).toBe('amount_mismatch');
    expect((await refusal(gate.handle(answer(bad('m2'))))).code).toBe('amount_mismatch');
    // A perfectly valid third payment is shed by rate, before consistency.
    expect((await refusal(gate.handle(answer(payment({ intentId: 'ok' }))))).code).toBe(
      'rate_limited',
    );
  });
});

describe('velocity: settled-spend caps (maxPayments / maxAmount)', () => {
  it('caps settled payments per window and recovers when the window slides', async () => {
    const c = clock();
    const { gate } = gateWith({ now: c.now, velocity: { windowMs: 60_000, maxPayments: 2 } });
    expect((await gate.handle(answer(payment({ intentId: 'a' })))).kind).toBe('paid');
    expect((await gate.handle(answer(payment({ intentId: 'b' })))).kind).toBe('paid');

    const third = payment({ intentId: 'c' });
    const outcome = await refusal(gate.handle(answer(third)));
    expect(outcome).toMatchObject({ status: 429, code: 'velocity_exceeded', retryAfterSeconds: 60 });

    c.advance(60_001);
    expect((await gate.handle(answer(third))).kind).toBe('paid');
  });

  it('a velocity-refused header is NOT replay-burned', async () => {
    const c = clock();
    const { gate } = gateWith({ now: c.now, velocity: { windowMs: 60_000, maxPayments: 1 } });
    expect((await gate.handle(answer(payment({ intentId: 'a' })))).kind).toBe('paid');
    const held = payment({ intentId: 'held' });
    expect((await refusal(gate.handle(answer(held)))).code).toBe('velocity_exceeded');
    c.advance(60_001);
    // Same signed header, presented again: settles (a burn would refuse payment_replayed).
    expect((await gate.handle(answer(held))).kind).toBe('paid');
  });

  it('sums the amount cap per asset — other assets do not count toward it', async () => {
    const c = clock();
    const { gate } = gateWith({ now: c.now, velocity: { windowMs: 60_000, maxAmount: '0.08' } });
    // 0.05 USDC settles, then 0.05 DAI settles: separate sums (0.05 each ≤ 0.08).
    expect((await gate.handle(answer(payment({ intentId: 'usdc' })))).kind).toBe('paid');
    const dai = (id: string) => ({
      method: 'GET',
      url: URL_DAI,
      payment: payment({ intentId: id }),
    });
    expect((await gate.handle(dai('dai1'))).kind).toBe('paid');
    // Second DAI payment would put DAI at 0.10 > 0.08.
    const outcome = await refusal(gate.handle(dai('dai2')));
    expect(outcome).toMatchObject({ code: 'velocity_exceeded', retryAfterSeconds: 60 });
    expect(outcome.reason).toContain('DAI');
  });

  it('a single payment above maxAmount refuses with NO Retry-After (it never clears)', async () => {
    const { gate } = gateWith({ velocity: { windowMs: 60_000, maxAmount: '0.04' } });
    const outcome = await refusal(gate.handle(answer(payment())));
    expect(outcome).toMatchObject({ status: 429, code: 'velocity_exceeded' });
    expect(outcome.retryAfterSeconds).toBeUndefined();
  });

  it('rejects misconfigured velocity at construction', () => {
    const base = { windowMs: 1000 };
    expect(() => gateWith({ velocity: { windowMs: 0, maxAttempts: 1 } })).toThrow(/windowMs/);
    expect(() => gateWith({ velocity: base })).toThrow(/at least one/);
    expect(() => gateWith({ velocity: { ...base, maxPayments: 1.5 } })).toThrow(/positive integer/);
    expect(() => gateWith({ velocity: { ...base, maxAmount: '-3' } })).toThrow(/decimal/);
    expect(() => validateVelocity({ windowMs: 1000, maxAttempts: 0 })).toThrow(/positive integer/);
  });
});

describe('rails retry policy', () => {
  it('retries verify transport blips and settles on a later attempt', async () => {
    let calls = 0;
    const { gate } = gateWith({
      rails: stubRails({
        async verify() {
          calls += 1;
          if (calls < 3) throw new TypeError('socket reset');
        },
      }),
    });
    expect((await gate.handle(answer(payment()))).kind).toBe('paid');
    expect(calls).toBe(3);
  });

  it('exhausted verify retries refuse rails_unavailable AND release the slot', async () => {
    let down = true;
    const { gate, events } = gateWith({
      rails: stubRails({
        async verify() {
          if (down) throw new TypeError('ECONN something');
        },
      }),
    });
    const header = payment({ intentId: 'persist' });
    const outcome = await refusal(gate.handle(answer(header)));
    expect(outcome).toMatchObject({ status: 503, code: 'rails_unavailable' });
    expect(outcome.body).toMatchObject({ retriable: true });
    expect(outcome.reason).toContain('NOT settled');
    expect(events.at(-1)).toMatchObject({ type: 'gate.refused', code: 'rails_unavailable' });

    // Rails come back: the SAME header settles — the slot was released.
    down = false;
    expect((await gate.handle(answer(header))).kind).toBe('paid');
  });

  it('retries settle only when the rails were provably never reached', async () => {
    let calls = 0;
    const { gate } = gateWith({
      rails: stubRails({
        async settle() {
          calls += 1;
          if (calls === 1) throw new RailsUnreachableError('connect ECONNREFUSED');
          return { header: 'c2V0dGxlZA==', transaction: '0xtx', network: 'base' };
        },
      }),
    });
    expect((await gate.handle(answer(payment()))).kind).toBe('paid');
    expect(calls).toBe(2);
  });

  it('an ambiguous settle failure refuses settle_unknown at once and the slot STAYS burned', async () => {
    let calls = 0;
    const { gate, events } = gateWith({
      rails: stubRails({
        async settle() {
          calls += 1;
          throw new TypeError('socket hang up mid-response');
        },
      }),
    });
    const header = payment({ intentId: 'ambiguous' });
    const outcome = await refusal(gate.handle(answer(header)));
    expect(outcome).toMatchObject({ status: 503, code: 'settle_unknown' });
    expect(outcome.body).toMatchObject({ retriable: false });
    expect(calls).toBe(1); // never retried — the money may have moved
    expect(events.at(-1)).toMatchObject({ type: 'gate.refused', code: 'settle_unknown', payer: WALLET });

    // Re-presenting is refused: replay protection holds until reconciliation.
    expect((await refusal(gate.handle(answer(header)))).code).toBe('payment_replayed');
    expect(calls).toBe(1);
  });

  it('a GateError from the rails is a semantic verdict — never retried', async () => {
    let calls = 0;
    const { gate } = gateWith({
      rails: stubRails({
        async verify() {
          calls += 1;
          throw new GateError('verify_failed', 'bad signature');
        },
      }),
    });
    const outcome = await refusal(gate.handle(answer(payment())));
    expect(outcome).toMatchObject({ status: 402, code: 'verify_failed' });
    expect(calls).toBe(1);
  });
});

describe('facilitatorClientRails transport classification', () => {
  const requirement = {} as never; // stubs throw before touching it

  function neverSentError() {
    return new TypeError('fetch failed', {
      cause: new AggregateError(
        [Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:443'), { code: 'ECONNREFUSED' })],
        'All connection attempts failed',
      ),
    });
  }

  it('tags provably-never-sent fetch errors as RailsUnreachableError', async () => {
    const client: FacilitatorClientLike = {
      async verify() {
        throw new TypeError('fetch failed', {
          cause: Object.assign(new Error('getaddrinfo ENOTFOUND x402.org'), { code: 'ENOTFOUND' }),
        });
      },
      async settle() {
        throw neverSentError();
      },
    };
    const rails = facilitatorClientRails(client);
    await expect(rails.verify(payment(), requirement)).rejects.toBeInstanceOf(
      RailsUnreachableError,
    );
    await expect(rails.settle(payment(), requirement)).rejects.toBeInstanceOf(
      RailsUnreachableError,
    );
  });

  it('lets ambiguous transport errors pass through untagged', async () => {
    const ambiguous = Object.assign(new Error('facilitator responded 502: bad gateway'), {
      status: 502,
    });
    const client: FacilitatorClientLike = {
      async verify() {
        throw ambiguous;
      },
      async settle() {
        throw ambiguous;
      },
    };
    const rails = facilitatorClientRails(client);
    await expect(rails.settle(payment(), requirement)).rejects.toBe(ambiguous);
  });
});

describe('AttemptWindow', () => {
  it('slides: counts in-window hits and reports when a slot frees', () => {
    const w = new AttemptWindow(1000);
    const t = 5_000;
    expect(w.record('p', t)).toBe(1);
    expect(w.record('p', t + 100)).toBe(2);
    expect(w.record('p', t + 200)).toBe(3);
    // With max 2, the gating hit is the middle one: frees at t+100+1000.
    expect(w.msUntilSlot('p', t + 200, 2)).toBe(900);
    expect(w.record('p', t + 1_050)).toBe(3); // hit at t expired; t+100 and t+200 remain
    expect(w.msUntilSlot('p', t + 1_050, 3)).toBe(50);
    expect(w.msUntilSlot('p', t + 1_050, 4)).toBe(0);
  });
});
