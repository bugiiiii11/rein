import { describe, it, expect } from 'vitest';
import {
  PaymentRequired,
  atomicToDecimal,
  decimalToAtomic,
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

describe('decimalToAtomic', () => {
  it('round-trips with atomicToDecimal at 6 decimals', () => {
    expect(decimalToAtomic('0.01', 6)).toBe('10000');
    expect(decimalToAtomic('1', 6)).toBe('1000000');
    expect(decimalToAtomic('0.000001', 6)).toBe('1');
    expect(decimalToAtomic('1.5', 6)).toBe('1500000');
    expect(decimalToAtomic('0', 6)).toBe('0');
  });

  it('handles zero decimals and strips leading zeros', () => {
    expect(decimalToAtomic('123', 0)).toBe('123');
    expect(decimalToAtomic('007', 0)).toBe('7');
  });

  it('rejects sub-atomic precision and malformed input', () => {
    expect(() => decimalToAtomic('0.0000001', 6)).toThrow(TypeError);
    expect(() => decimalToAtomic('1.5', 0)).toThrow(TypeError);
    expect(() => decimalToAtomic('-1', 6)).toThrow(TypeError);
    expect(() => decimalToAtomic('1,5', 6)).toThrow(TypeError);
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

  /**
   * This used to read "honors extra.decimals overrides", and honouring them is
   * the whole attack. `extra` is the counterparty's own 402 challenge and the
   * payer signs the RAW atomic value, so a vendor that gets to state the
   * precision owns the ratio between the amount policy judges and the amount
   * the wallet authorizes: 500000000 at `decimals: 12` is evaluated as 0.0005
   * and settles for 500 USDC. An offer whose stated precision disagrees with
   * the token's is one whose amount cannot be agreed on, so it is ungovernable
   * and skipped rather than reinterpreted.
   */
  it('refuses an offer whose stated decimals disagree with the token', () => {
    expect(
      selectRequirement([requirement({ maxAmountRequired: '150', extra: { decimals: 2 } })]),
    ).toBeUndefined();
  });

  it('reads the amount at the token’s own precision, not the vendor’s', () => {
    const resolved = selectRequirement([
      requirement({ maxAmountRequired: '500000000', extra: { decimals: 12 } }),
    ]);
    expect(resolved).toBeUndefined();

    // The same charge, stated honestly, is the 500 USDC it always was.
    const honest = selectRequirement([requirement({ maxAmountRequired: '500000000' })]);
    expect(honest?.amount).toBe('500');
  });

  it('agrees with a vendor that states the right precision', () => {
    const resolved = selectRequirement([
      requirement({ maxAmountRequired: '150', extra: { decimals: 6 } }),
    ]);
    expect(resolved?.amount).toBe('0.00015');
  });

  /**
   * `extra.symbol` is the counterparty naming its own token, and it used to be
   * consulted BEFORE the canonical address table. Any EIP-3009 contract could
   * therefore call itself USDC: the engine evaluated the agent's USDC caps and
   * budgets, and the payer signed a transfer against the attacker's contract,
   * spending a balance no USDC policy was written about.
   */
  it('will not let extra.symbol rename an unknown token', () => {
    const impostor = '0x000000000000000000000000000000000000dEaD';
    expect(
      selectRequirement([requirement({ asset: impostor, extra: { symbol: 'USDC' } })]),
    ).toBeUndefined();
  });

  it('still resolves a known contract, and a bare symbol that is not an address', () => {
    expect(selectRequirement([requirement()])?.asset).toBe('USDC');
    expect(
      selectRequirement([requirement({ asset: 'some-token', extra: { symbol: 'USDC' } })])?.asset,
    ).toBe('USDC');
  });

  it('returns undefined when nothing qualifies', () => {
    expect(selectRequirement([requirement({ network: 'arbitrum' })])).toBeUndefined();
  });

  /**
   * The testnet/mainnet boundary. It cannot live downstream of the engine:
   * networkToChain folds base-sepolia INTO base (policy is written about
   * chains, not deployments), so by the time an intent reaches evaluate the
   * two are indistinguishable and every policy that allows one allows the
   * other. Selection is the last place they can still be told apart.
   */
  describe('network allow-list', () => {
    it('skips offers outside the list and picks an allowed one further down', () => {
      const resolved = selectRequirement(
        [
          requirement({ network: 'base', maxAmountRequired: '9000000' }),
          requirement({ network: 'base-sepolia', maxAmountRequired: '10000' }),
        ],
        {},
        ['base-sepolia'],
      );
      expect(resolved?.requirement.network).toBe('base-sepolia');
      expect(resolved?.amount).toBe('0.01');
    });

    it('matches across dialects, so a CAIP-2 offer honours a v1 allow-list', () => {
      expect(
        selectRequirement([requirement({ network: 'eip155:84532' })], {}, ['base-sepolia']),
      ).toBeDefined();
      expect(
        selectRequirement([requirement({ network: 'base-sepolia' })], {}, ['eip155:84532']),
      ).toBeDefined();
    });

    it('fails closed when a 402 offers only disallowed networks', () => {
      expect(
        selectRequirement([requirement({ network: 'base' })], {}, ['base-sepolia']),
      ).toBeUndefined();
      expect(
        selectRequirement([requirement({ network: 'eip155:8453' })], {}, ['base-sepolia']),
      ).toBeUndefined();
    });

    it('is unrestricted when no list is given (the pre-profile behaviour)', () => {
      expect(selectRequirement([requirement({ network: 'base' })])).toBeDefined();
    });
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
