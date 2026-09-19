/**
 * The reference vendor, driven over a real socket with STUBBED rails.
 *
 * Nothing here talks to a facilitator: the thing under test is what this
 * process quotes, routes and serves, and a live settlement would only prove
 * the facilitator works. The one live path is exercised by `live.yml` against
 * the deployed vendor.
 */
import { describe, expect, it } from 'vitest';
import type { GateRails } from '@reinconsole/gate';
import { readVendorConfig } from './config';
import { createVendorServer, laneFor, type VendorServer } from './server';

const PAY_TO = '0x1111111111111111111111111111111111111111';
const MAINNET_PAY_TO = '0x2222222222222222222222222222222222222222';

const TESTNET_ENV = { REIN_VENDOR_PAY_TO: PAY_TO, PORT: '0' } as NodeJS.ProcessEnv;
const BOTH_ENV = {
  ...TESTNET_ENV,
  REIN_VENDOR_MAINNET: '1',
  REIN_VENDOR_MAINNET_PAY_TO: MAINNET_PAY_TO,
  REIN_CDP_API_KEY_ID: 'id',
  REIN_CDP_API_KEY_SECRET: 'secret',
} as NodeJS.ProcessEnv;

/** Rails that settle anything, so the paid path can be reached without money. */
function alwaysSettles(network: string): GateRails {
  return {
    verify: async () => undefined,
    settle: async () => ({
      header: 'c2V0dGxlZA==',
      transaction: '0xtx',
      network,
      payer: '0x9999999999999999999999999999999999999999',
    }),
  };
}

async function start(env: NodeJS.ProcessEnv): Promise<{ vendor: VendorServer; url: string }> {
  const config = readVendorConfig(env);
  const vendor = createVendorServer({
    config: { ...config, host: '127.0.0.1' },
    railsFor: (lane) => alwaysSettles(lane.profile.network),
  });
  const port = await vendor.listen();
  return { vendor, url: `http://127.0.0.1:${port}` };
}

/** Any well-formed-enough payment header; the stub rails accept it. */
function paymentHeader(network: string, asset: string, payTo: string, value: string): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network,
      payload: {
        signature: '0xsig',
        authorization: {
          from: '0x9999999999999999999999999999999999999999',
          to: payTo,
          value,
          validAfter: '0',
          validBefore: String(Math.floor(Date.now() / 1000) + 600),
          nonce: `0x${Math.random().toString(16).slice(2).padEnd(64, '0')}`,
        },
      },
      asset,
    }),
  ).toString('base64');
}

describe('the reference vendor — what it sells', () => {
  it('quotes /testnet/v1/ping at $0.001 rather than serving it free', async () => {
    const { vendor, url } = await start(TESTNET_ENV);
    try {
      const res = await fetch(`${url}/testnet/v1/ping`);
      expect(res.status).toBe(402);
      const body = (await res.json()) as { accepts: { maxAmountRequired: string; payTo: string }[] };
      // $0.001 at 6 decimals.
      expect(body.accepts[0]?.maxAmountRequired).toBe('1000');
      expect(body.accepts[0]?.payTo).toBe(PAY_TO);
    } finally {
      await vendor.close();
    }
  });

  it('quotes the score route higher than the ping', async () => {
    const { vendor, url } = await start(TESTNET_ENV);
    try {
      const res = await fetch(`${url}/testnet/v1/scores/vendor/example.com`);
      const body = (await res.json()) as { accepts: { maxAmountRequired: string }[] };
      expect(body.accepts[0]?.maxAmountRequired).toBe('5000');
    } finally {
      await vendor.close();
    }
  });

  it('quotes the EIP-712 domain the payer must actually sign against', async () => {
    const { vendor, url } = await start(TESTNET_ENV);
    try {
      const res = await fetch(`${url}/testnet/v1/ping`);
      const body = (await res.json()) as { accepts: { extra?: Record<string, unknown> }[] };
      expect(body.accepts[0]?.extra).toEqual({ name: 'USDC', version: '2' });
    } finally {
      await vendor.close();
    }
  });

  it('serves the ping once the gate has settled', async () => {
    const { vendor, url } = await start(TESTNET_ENV);
    try {
      const quote = (await (await fetch(`${url}/testnet/v1/ping`)).json()) as {
        accepts: { network: string; asset: string; payTo: string; maxAmountRequired: string }[];
      };
      const offer = quote.accepts[0]!;
      const res = await fetch(`${url}/testnet/v1/ping`, {
        headers: {
          'X-PAYMENT': paymentHeader(
            offer.network,
            offer.asset,
            offer.payTo,
            offer.maxAmountRequired,
          ),
        },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ pong: true, network: 'base-sepolia' });
      expect(res.headers.get('x-payment-response')).toBeTruthy();
    } finally {
      await vendor.close();
    }
  });

  /**
   * A paid lookup answers even when nothing is known. Taking the money and
   * returning a 404 would read as a broken route; returning a plausible score
   * for a host nobody has transacted with would be the worse failure a
   * reputation service can have.
   */
  it('answers an unknown host with known:false rather than a score or a 404', async () => {
    const { vendor, url } = await start(TESTNET_ENV);
    try {
      const path = '/testnet/v1/scores/vendor/nobody.example';
      const quote = (await (await fetch(`${url}${path}`)).json()) as {
        accepts: { network: string; asset: string; payTo: string; maxAmountRequired: string }[];
      };
      const offer = quote.accepts[0]!;
      const res = await fetch(`${url}${path}`, {
        headers: {
          'X-PAYMENT': paymentHeader(
            offer.network,
            offer.asset,
            offer.payTo,
            offer.maxAmountRequired,
          ),
        },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        host: 'nobody.example',
        known: false,
        score: null,
      });
    } finally {
      await vendor.close();
    }
  });

  it('serves /stats and /health free — the dashboard must not pay to render', async () => {
    const { vendor, url } = await start(TESTNET_ENV);
    try {
      await fetch(`${url}/testnet/v1/ping`); // one quote, to make the counter move
      const stats = (await (await fetch(`${url}/stats`)).json()) as {
        lanes: { network: string; quoted: number; payTo: string }[];
      };
      expect(stats.lanes).toHaveLength(1);
      expect(stats.lanes[0]).toMatchObject({ network: 'base-sepolia', quoted: 1, payTo: PAY_TO });
      expect((await fetch(`${url}/health`)).status).toBe(200);
    } finally {
      await vendor.close();
    }
  });
});

describe('the reference vendor — two lanes in one process', () => {
  /**
   * The worst routing bug this process could have: the mainnet lane's empty
   * prefix matches everything, so a naive first-match would quote a testnet
   * path at the mainnet treasury on the mainnet chain.
   */
  it('never lets the mainnet lane swallow a /testnet path', async () => {
    const { vendor, url } = await start(BOTH_ENV);
    try {
      const testnet = (await (await fetch(`${url}/testnet/v1/ping`)).json()) as {
        accepts: { network: string; payTo: string }[];
      };
      expect(testnet.accepts[0]).toMatchObject({ network: 'base-sepolia', payTo: PAY_TO });

      const mainnet = (await (await fetch(`${url}/v1/ping`)).json()) as {
        accepts: { network: string; payTo: string; extra?: Record<string, unknown> }[];
      };
      expect(mainnet.accepts[0]).toMatchObject({ network: 'base', payTo: MAINNET_PAY_TO });
      expect(mainnet.accepts[0]?.extra).toEqual({ name: 'USD Coin', version: '2' });
    } finally {
      await vendor.close();
    }
  });

  it('picks the longest matching prefix, whatever order the lanes are in', async () => {
    const lanes = [
      { lane: { prefix: '' } },
      { lane: { prefix: '/testnet' } },
    ] as unknown as Parameters<typeof laneFor>[0];
    expect(laneFor(lanes, '/testnet/v1/ping')?.lane.prefix).toBe('/testnet');
    expect(laneFor(lanes, '/v1/ping')?.lane.prefix).toBe('');
    expect(laneFor([...lanes].reverse(), '/testnet/v1/ping')?.lane.prefix).toBe('/testnet');
  });

  /**
   * Until Sprint 8 this process cannot take a real payment even if one is
   * sent: with the mainnet lane unbuilt there is no gate in front of /v1/*.
   */
  it('has no mainnet route at all when the lane is off', async () => {
    const { vendor, url } = await start(TESTNET_ENV);
    try {
      const res = await fetch(`${url}/v1/ping`);
      expect(res.status).toBe(404);
      expect(res.status).not.toBe(402);
    } finally {
      await vendor.close();
    }
  });

  /**
   * The Bazaar listing rides the v2 402, and only the mainnet lane advertises
   * v2 (a listing requires a CDP-settled v2 quote). So the testnet lane
   * declares the same discovery metadata and puts none of it on the wire —
   * an intended asymmetry, pinned here so it is not read later as a bug.
   */
  it('publishes the Bazaar listing on mainnet and stays silent on testnet', async () => {
    const { vendor, url } = await start(BOTH_ENV);
    try {
      const mainnet = await fetch(`${url}/v1/ping`);
      const header = mainnet.headers.get('payment-required');
      expect(header).toBeTruthy();
      const advertised = JSON.parse(Buffer.from(header!, 'base64').toString('utf8')) as {
        extensions: { bazaar?: { info: { path: string }; schema: { output: unknown } } };
      };
      expect(advertised.extensions.bazaar?.info.path).toBe('/v1/ping');
      expect(advertised.extensions.bazaar?.schema.output).toMatchObject({
        required: ['pong', 'network', 'at'],
      });

      const testnet = await fetch(`${url}/testnet/v1/ping`);
      expect(testnet.headers.get('payment-required')).toBeNull();
    } finally {
      await vendor.close();
    }
  });

  it('keeps each lane’s revenue on its own books', async () => {
    const { vendor, url } = await start(BOTH_ENV);
    try {
      await fetch(`${url}/testnet/v1/ping`);
      await fetch(`${url}/testnet/v1/ping`);
      await fetch(`${url}/v1/ping`);
      const stats = (await (await fetch(`${url}/stats`)).json()) as {
        lanes: { network: string; quoted: number }[];
      };
      const byNetwork = Object.fromEntries(stats.lanes.map((l) => [l.network, l.quoted]));
      expect(byNetwork).toEqual({ 'base-sepolia': 2, base: 1 });
    } finally {
      await vendor.close();
    }
  });
});
