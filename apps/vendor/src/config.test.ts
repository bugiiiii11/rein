/**
 * The vendor's configuration is where the mainnet mistakes get made, so this
 * suite is mostly about what it REFUSES to boot with.
 */
import { describe, expect, it } from 'vitest';
import { PAYAI_FACILITATOR_URL, readVendorConfig, routesFor, VendorConfigError } from './config';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const MAINNET_PAY_TO = '0x2222222222222222222222222222222222222222';

const base = { REIN_VENDOR_PAY_TO: PAY_TO } as NodeJS.ProcessEnv;

describe('readVendorConfig', () => {
  it('builds the testnet lane alone by default', () => {
    const config = readVendorConfig({ ...base });
    expect(config.lanes).toHaveLength(1);
    expect(config.lanes[0]).toMatchObject({ prefix: '/testnet', payTo: PAY_TO });
    expect(config.lanes[0]?.profile.name).toBe('testnet');
  });

  /**
   * The lane that costs real money must be armed deliberately. A default that
   * turned it on with a plausible-looking address would be one typo away from
   * a live mainnet seller nobody meant to run.
   */
  it('does not arm mainnet without REIN_VENDOR_MAINNET=1', () => {
    const config = readVendorConfig({
      ...base,
      REIN_VENDOR_MAINNET_PAY_TO: MAINNET_PAY_TO,
      REIN_CDP_API_KEY_ID: 'id',
      REIN_CDP_API_KEY_SECRET: 'secret',
    });
    expect(config.lanes.map((l) => l.profile.name)).toEqual(['testnet']);
  });

  it('arms mainnet with its own treasury and the v2 advertisement', () => {
    const config = readVendorConfig({
      ...base,
      REIN_VENDOR_MAINNET: '1',
      REIN_VENDOR_MAINNET_PAY_TO: MAINNET_PAY_TO,
      REIN_CDP_API_KEY_ID: 'id',
      REIN_CDP_API_KEY_SECRET: 'secret',
    });
    const mainnet = config.lanes.find((l) => l.profile.name === 'mainnet');
    expect(mainnet).toMatchObject({ prefix: '', payTo: MAINNET_PAY_TO, advertiseV2: true });
    // CDP credentials mean the profile's own facilitator, which is CDP.
    expect(mainnet?.facilitatorUrl).toBeUndefined();
    expect(mainnet?.profile.facilitatorAuth).toBe('cdp');
    // The constant S58 found hardcoded. Base mainnet's USDC is `USD Coin`;
    // signing `USDC` there produces a valid signature the token rejects.
    expect(mainnet?.profile.eip712).toEqual({ name: 'USD Coin', version: '2' });
    expect(config.lanes.find((l) => l.profile.name === 'testnet')?.profile.eip712.name).toBe('USDC');
  });

  /**
   * The Sprint 8 lane: no CDP account, so PayAI settles keyless. No v2
   * header either -- the Bazaar listing it carries needs CDP settlement.
   */
  it('arms a keyless mainnet lane on PayAI when no CDP credentials are set', () => {
    const config = readVendorConfig({
      ...base,
      REIN_VENDOR_MAINNET: '1',
      REIN_VENDOR_MAINNET_PAY_TO: MAINNET_PAY_TO,
    });
    const mainnet = config.lanes.find((l) => l.profile.name === 'mainnet');
    expect(mainnet).toMatchObject({
      prefix: '',
      payTo: MAINNET_PAY_TO,
      advertiseV2: false,
      facilitatorUrl: 'https://facilitator.payai.network',
    });
    expect(PAYAI_FACILITATOR_URL).toBe('https://facilitator.payai.network');
    expect(mainnet?.profile.eip712).toEqual({ name: 'USD Coin', version: '2' });
    expect(config.cdp).toBeUndefined();
    // The testnet lane keeps its own facilitator.
    expect(config.lanes.find((l) => l.profile.name === 'testnet')?.facilitatorUrl).toBeUndefined();
  });

  it('refuses half a CDP credential pair rather than guessing a facilitator', () => {
    for (const half of [{ REIN_CDP_API_KEY_ID: 'id' }, { REIN_CDP_API_KEY_SECRET: 'secret' }]) {
      expect(() =>
        readVendorConfig({
          ...base,
          REIN_VENDOR_MAINNET: '1',
          REIN_VENDOR_MAINNET_PAY_TO: MAINNET_PAY_TO,
          ...half,
        }),
      ).toThrow(/must be set together/);
    }
  });

  it('refuses a mainnet lane that would reuse the testnet treasury by omission', () => {
    expect(() =>
      readVendorConfig({
        ...base,
        REIN_VENDOR_MAINNET: '1',
        REIN_CDP_API_KEY_ID: 'id',
        REIN_CDP_API_KEY_SECRET: 'secret',
      }),
    ).toThrow(/REIN_VENDOR_MAINNET_PAY_TO is required/);
  });

  it('refuses a payTo that is not an address', () => {
    expect(() => readVendorConfig({ REIN_VENDOR_PAY_TO: 'treasury.eth' })).toThrow(
      /must be a 0x EVM address/,
    );
    expect(() => readVendorConfig({})).toThrow(/REIN_VENDOR_PAY_TO is required/);
  });

  it('refuses a nonsense PORT rather than listening somewhere surprising', () => {
    expect(() => readVendorConfig({ ...base, PORT: 'eight-thousand' })).toThrow(VendorConfigError);
    expect(() => readVendorConfig({ ...base, PORT: '99999' })).toThrow(VendorConfigError);
  });
});

describe('routesFor', () => {
  it('prefixes every priced route with its lane', () => {
    const [testnet] = readVendorConfig({ ...base }).lanes;
    const paths = routesFor(testnet!).map((r) => r.path);
    expect(paths).toEqual(['/testnet/v1/ping', '/testnet/v1/scores/vendor/*']);
  });

  /**
   * Literal prices, not the table read back: the point is that mainnet does
   * NOT quote testnet's $0.001, which loses money on every Base settlement
   * once the facilitator bills gas + 30% (S77). A shared constant would pass
   * this test while pricing both lanes the same.
   */
  it('prices the mainnet lane at the root, above what a settlement costs', () => {
    const config = readVendorConfig({
      ...base,
      REIN_VENDOR_MAINNET: '1',
      REIN_VENDOR_MAINNET_PAY_TO: MAINNET_PAY_TO,
      REIN_CDP_API_KEY_ID: 'id',
      REIN_CDP_API_KEY_SECRET: 'secret',
    });
    const mainnet = config.lanes.find((l) => l.profile.name === 'mainnet')!;
    const routes = routesFor(mainnet);
    expect(routes.map((r) => r.path)).toEqual(['/v1/ping', '/v1/scores/vendor/*']);
    expect(routes.map((r) => r.price)).toEqual(['0.01', '0.02']);

    const testnet = config.lanes.find((l) => l.profile.name === 'testnet')!;
    expect(routesFor(testnet).map((r) => r.price)).toEqual(['0.001', '0.005']);
  });
});
