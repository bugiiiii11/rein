import { describe, it, expect } from 'vitest';
import {
  PaymentRequired,
  atomicToDecimal,
  networkToChain,
  resolveAsset,
  selectRequirement,
  toIntentSubmission,
  type PaymentRequirement,
} from './x402.js';

function requirement(overrides: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: '10000',
    payTo: '0xVENDOR',
    asset: 'USDC',
    ...overrides,
  };
}

describe('PaymentRequired schema', () => {
  it('parses a spec-shaped 402 body', () => {
    const body = {
      x402Version: 1,
      accepts: [requirement({ resource: '/v1/answer', description: 'one answer' })],
      error: 'X-PAYMENT header is required',
    };
    expect(PaymentRequired.parse(body).accepts).toHaveLength(1);
  });

  it('rejects bodies without offers or with non-integer amounts', () => {
    expect(PaymentRequired.safeParse({ x402Version: 1, accepts: [] }).success).toBe(false);
    const bad = { x402Version: 1, accepts: [requirement({ maxAmountRequired: '0.01' })] };
    expect(PaymentRequired.safeParse(bad).success).toBe(false);
  });
});

describe('atomicToDecimal', () => {
  it('converts atomic USDC units at 6 decimals', () => {
    expect(atomicToDecimal('10000', 6)).toBe('0.01');
    expect(atomicToDecimal('1000000', 6)).toBe('1');
    expect(atomicToDecimal('1', 6)).toBe('0.000001');
    expect(atomicToDecimal('1500000', 6)).toBe('1.5');
  });

  it('handles zero decimals and leading zeros', () => {
    expect(atomicToDecimal('123', 0)).toBe('123');
    expect(atomicToDecimal('0', 6)).toBe('0');
    expect(atomicToDecimal('0042', 0)).toBe('42');
  });

  it('rejects non-integer input', () => {
    expect(() => atomicToDecimal('1.5', 6)).toThrow(TypeError);
  });
});

describe('network and asset mapping', () => {
  it('maps x402 networks (testnets included) to Rein chains', () => {
    expect(networkToChain('base')).toBe('base');
    expect(networkToChain('base-sepolia')).toBe('base');
    expect(networkToChain('eip155:8453')).toBe('base');
    expect(networkToChain('eip155:84532')).toBe('base');
    expect(networkToChain('Solana')).toBe('solana');
    expect(networkToChain('bsc')).toBe('bnb');
    expect(networkToChain('arbitrum')).toBeUndefined();
    expect(networkToChain('eip155:1')).toBeUndefined();
  });

  it('resolves assets by symbol, extra.symbol, and known addresses', () => {
    expect(resolveAsset(requirement({ asset: 'usdc' }))).toBe('USDC');
    expect(resolveAsset(requirement({ asset: '0xUnknown', extra: { symbol: 'EURC' } }))).toBe(
      'EURC',
    );
    expect(resolveAsset(requirement({ asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' }))).toBe(
      'USDC',
    );
    expect(resolveAsset(requirement({ asset: '0xUnknown' }))).toBeUndefined();
    expect(resolveAsset(requirement({ asset: '0xCustom' }), { '0xcustom': 'USDT' })).toBe('USDT');
  });
});

describe('selectRequirement', () => {
  it('picks the first governable offer, skipping unsupported ones', () => {
    const resolved = selectRequirement([
      requirement({ scheme: 'upto' }),
      requirement({ network: 'arbitrum' }),
      requirement({ asset: '0xUnknown' }),
      requirement({ network: 'base-sepolia', maxAmountRequired: '250000' }),
    ]);
    expect(resolved).toBeDefined();
    expect(resolved?.chain).toBe('base');
    expect(resolved?.asset).toBe('USDC');
    expect(resolved?.amount).toBe('0.25');
  });

  it('honors extra.decimals overrides', () => {
    const resolved = selectRequirement([
      requirement({ maxAmountRequired: '150', extra: { decimals: 2 } }),
    ]);
    expect(resolved?.amount).toBe('1.5');
  });

  it('returns undefined when nothing qualifies', () => {
    expect(selectRequirement([requirement({ network: 'arbitrum' })])).toBeUndefined();
  });
});

describe('toIntentSubmission', () => {
  it('derives vendor and resource from the request URL and offer', () => {
    const resolved = selectRequirement([requirement({ resource: '/v1/answer' })]);
    const submission = toIntentSubmission(
      resolved!,
      'https://api.vendor.test/v1/answer?q=x',
      'agt_01JEXAMPLEEXAMPLEEXAMPLE00',
      { purpose: 'research' },
    );
    expect(submission.vendor).toEqual({ host: 'api.vendor.test', address: '0xVENDOR' });
    expect(submission.resource).toBe('/v1/answer');
    expect(submission.amount).toBe('0.01');
    expect(submission.asset).toBe('USDC');
    expect(submission.chain).toBe('base');
    expect(submission.taskContext?.purpose).toBe('research');
  });

  it('falls back to the URL pathname when the offer omits resource', () => {
    const resolved = selectRequirement([requirement()]);
    const submission = toIntentSubmission(
      resolved!,
      'https://api.vendor.test/v2/search',
      'agt_01JEXAMPLEEXAMPLEEXAMPLE00',
      undefined,
    );
    expect(submission.resource).toBe('/v2/search');
  });
});
