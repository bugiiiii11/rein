import { describe, it, expect } from 'vitest';
import type { FetchLike } from '@reinconsole/sdk';
import { RailsError } from './errors.js';
import { createProfileFacilitator } from './cdp.js';
import { FacilitatorClient } from './facilitator.js';
import { MAINNET, TESTNET } from './profiles.js';

/** Records every request the client makes and answers with a stub body. */
function recorder(body: unknown = { isValid: true }): {
  fetch: FetchLike;
  calls: { url: string; method: string; headers: Record<string, string> }[];
} {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fetch: FetchLike = async (input, init) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ]),
      ),
    });
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetch, calls };
}

describe('createProfileFacilitator', () => {
  it('points at the profile facilitator and sends no credentials on testnet', async () => {
    const { fetch, calls } = recorder();
    const client = createProfileFacilitator(TESTNET, { fetch });

    expect(client.url).toBe(TESTNET.facilitatorUrl);
    await client.supported();
    expect(calls[0]?.headers['authorization']).toBeUndefined();
  });

  /**
   * The failure this prevents: an unauthenticated call to the CDP facilitator
   * comes back 401, which at settlement time is hard to tell from a bad
   * payment — on the one network where the money is real. Refuse at
   * construction instead.
   */
  it('refuses to build a mainnet client without CDP credentials', () => {
    expect(() => createProfileFacilitator(MAINNET)).toThrowError(RailsError);
    expect(() => createProfileFacilitator(MAINNET)).toThrow(/CDP credentials/);
  });

  /**
   * The header factory is called PER REQUEST and told the method and path,
   * because a CDP bearer is a short-lived JWT bound to both. A client that
   * captured one header object at construction would authenticate its first
   * call and fail every later one.
   */
  it('resolves credentials per request, over that request method and path', async () => {
    const seen: { method: string; path: string }[] = [];
    const { fetch, calls } = recorder();
    const client = new FacilitatorClient({
      url: 'https://facilitator.test',
      fetch,
      authHeaders: (request) => {
        seen.push(request);
        return { authorization: `Bearer token-${seen.length}` };
      },
    });

    await client.supported();
    await client.verify({ x402Version: 1 }, {});

    expect(seen).toEqual([
      { method: 'GET', path: '/supported' },
      { method: 'POST', path: '/verify' },
    ]);
    expect(calls[0]?.headers['authorization']).toBe('Bearer token-1');
    expect(calls[1]?.headers['authorization']).toBe('Bearer token-2');
    // Auth is added to the POST, never in place of its content type.
    expect(calls[1]?.headers['content-type']).toBe('application/json');
  });

  /**
   * @coinbase/cdp-sdk is an optional peer and is NOT installed here, which is
   * the normal state for a testnet install. The failure has to name the
   * missing package and the fix: all a stdio harness shows is stderr, and a
   * module-resolution stack there reads as "Rein is broken".
   */
  it('fails with an actionable message when the optional CDP SDK is absent', async () => {
    const { fetch } = recorder();
    const client = createProfileFacilitator(MAINNET, {
      fetch,
      cdp: { apiKeyId: 'id', apiKeySecret: 'secret' },
    });
    expect(client.url).toBe(MAINNET.facilitatorUrl);
    await expect(client.supported()).rejects.toThrowError(RailsError);
    await expect(client.supported()).rejects.toThrow(/@coinbase\/cdp-sdk/);
  });
});
