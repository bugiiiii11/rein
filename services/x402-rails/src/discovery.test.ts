import { describe, it, expect } from 'vitest';
import type { FetchLike } from '@reinconsole/sdk';
import { discoverResources, selectDiscovered } from './discovery.js';
import { BASE_SEPOLIA_USDC_ADDRESS, BASE_USDC, MAINNET, TESTNET } from './profiles.js';

/** A v2 catalog entry in PayAI's shape. */
function v2(
  resource: string,
  offer: Partial<{ network: string; asset: string; amount: string; scheme: string }> = {},
  method: string | null = 'GET',
): unknown {
  return {
    resource,
    x402Version: 2,
    description: `entry ${resource}`,
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:8453',
        asset: BASE_USDC,
        amount: '10000',
        payTo: '0x0000000000000000000000000000000000000001',
        ...offer,
      },
    ],
    ...(method === null
      ? {}
      : { extensions: { bazaar: { info: { input: { type: 'http', method } } } } }),
  };
}

/** A v1 catalog entry: amount is maxAmountRequired, method under outputSchema. */
function v1(resource: string, maxAmountRequired: string, method = 'GET'): unknown {
  return {
    resource,
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'base',
        asset: BASE_USDC,
        maxAmountRequired,
        outputSchema: { input: { type: 'http', method } },
      },
    ],
  };
}

const MAX = 50_000n; // $0.05

describe('selectDiscovered', () => {
  it('reads both dialects and returns them cheapest first', () => {
    const found = selectDiscovered(
      [v2('https://a.test/x', { amount: '20000' }), v1('https://b.test/y', '5000')],
      { profile: MAINNET, maxAtomic: MAX },
    );
    expect(found.map((r) => [r.resource, r.amount, r.x402Version])).toEqual([
      ['https://b.test/y', 5000n, 1],
      ['https://a.test/x', 20000n, 2],
    ]);
  });

  it('keeps only the profile chain, in either spelling', () => {
    const items = [
      v2('https://main.test/a'),
      v2('https://main-v1-name.test/a', { network: 'base' }),
      v2('https://sepolia.test/a', { network: 'eip155:84532', asset: BASE_SEPOLIA_USDC_ADDRESS }),
      v2('https://solana.test/a', { network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' }),
    ];
    expect(selectDiscovered(items, { profile: MAINNET, maxAtomic: MAX }).map((r) => r.resource))
      .toEqual(['https://main.test/a', 'https://main-v1-name.test/a']);
    expect(selectDiscovered(items, { profile: TESTNET, maxAtomic: MAX }).map((r) => r.resource))
      .toEqual(['https://sepolia.test/a']);
  });

  it('matches the asset by ADDRESS, case-insensitively, and nothing else', () => {
    const found = selectDiscovered(
      [
        v2('https://lower.test/a', { asset: BASE_USDC.toLowerCase() }),
        // Right chain, wrong token -- a symbol claim would not rescue it.
        v2('https://other-token.test/a', { asset: '0x4200000000000000000000000000000000000006' }),
      ],
      { profile: MAINNET, maxAtomic: MAX },
    );
    expect(found.map((r) => r.resource)).toEqual(['https://lower.test/a']);
  });

  it('enforces the ceiling inclusively and drops $0 and unreadable amounts', () => {
    const found = selectDiscovered(
      [
        v2('https://at-cap.test/a', { amount: '50000' }),
        v2('https://over.test/a', { amount: '50001' }),
        v2('https://free.test/a', { amount: '0' }),
        v2('https://decimal.test/a', { amount: '0.01' }),
      ],
      { profile: MAINNET, maxAtomic: MAX },
    );
    expect(found.map((r) => r.resource)).toEqual(['https://at-cap.test/a']);
  });

  it('requires the entry to DECLARE the wanted method', () => {
    const found = selectDiscovered(
      [
        v2('https://get.test/a', {}, 'get'),
        v2('https://post.test/a', {}, 'POST'),
        v2('https://silent.test/a', {}, null),
        v1('https://v1-post.test/a', '1000', 'POST'),
      ],
      { profile: MAINNET, maxAtomic: MAX },
    );
    expect(found.map((r) => [r.resource, r.method])).toEqual([['https://get.test/a', 'GET']]);
  });

  it('drops route templates, non-https URLs, non-exact schemes and excluded hosts', () => {
    const found = selectDiscovered(
      [
        v2('https://api.test/v0/inboxes/:inbox_id/messages'),
        v2('https://api.test/v0/items/{id}'),
        v2('http://plain.test/a'),
        v2('not a url'),
        v2('https://upto.test/a', { scheme: 'upto' }),
        v2('https://vendor.reinconsole.com/v1/ping'),
        v2('https://ok.test/v1/quote?symbol=ETH'),
      ],
      { profile: MAINNET, maxAtomic: MAX, excludeHosts: ['VENDOR.reinconsole.com'] },
    );
    expect(found.map((r) => r.resource)).toEqual(['https://ok.test/v1/quote?symbol=ETH']);
  });

  it('skips malformed entries instead of failing the page', () => {
    const found = selectDiscovered(
      [null, 42, { resource: 7 }, { resource: 'https://x.test/a', accepts: [null] }, v2('https://ok.test/a')],
      { profile: MAINNET, maxAtomic: MAX },
    );
    expect(found.map((r) => r.resource)).toEqual(['https://ok.test/a']);
  });
});

describe('discoverResources', () => {
  function catalog(pages: unknown[][], total?: number): { fetch: FetchLike; urls: string[] } {
    const urls: string[] = [];
    const fetch: FetchLike = async (input) => {
      const url = String(input);
      urls.push(url);
      const offset = Number(new URL(url).searchParams.get('offset'));
      const items = pages[offset / 2] ?? [];
      return new Response(
        JSON.stringify({ items, pagination: { limit: 2, offset, total: total ?? pages.flat().length } }),
        { headers: { 'content-type': 'application/json' } },
      );
    };
    return { fetch, urls };
  }

  it('walks pages until it has enough matches', async () => {
    const { fetch, urls } = catalog([
      [v2('https://solana.test/a', { network: 'solana' }), v2('https://p1.test/a', { amount: '3000' })],
      [v2('https://p2.test/a', { amount: '1000' }), v2('https://p2.test/b')],
      [v2('https://p3.test/a')],
    ]);
    const found = await discoverResources({
      profile: MAINNET,
      maxAtomic: MAX,
      fetch,
      url: 'https://catalog.test/resources',
      pageSize: 2,
      want: 2,
    });
    expect(urls).toHaveLength(2);
    expect(found.map((r) => r.resource)).toEqual([
      'https://p2.test/a',
      'https://p1.test/a',
      'https://p2.test/b',
    ]);
  });

  it('stops at the end of the catalog and returns nothing rather than throwing', async () => {
    const { fetch, urls } = catalog([[v2('https://solana.test/a', { network: 'solana' })]]);
    const found = await discoverResources({
      profile: MAINNET,
      maxAtomic: MAX,
      fetch,
      url: 'https://catalog.test/resources',
      pageSize: 2,
    });
    expect(found).toEqual([]);
    expect(urls).toHaveLength(1);
  });

  it('surfaces an HTTP failure as a FacilitatorHttpError', async () => {
    const fetch: FetchLike = async () => new Response('down', { status: 503 });
    await expect(discoverResources({ profile: MAINNET, maxAtomic: MAX, fetch })).rejects.toThrow(
      /503/,
    );
  });
});
