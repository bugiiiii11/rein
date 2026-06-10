import type { FetchLike } from '@rein/sdk';
import type { Gate } from './gate.js';

export interface GatedFetchOptions {
  /** Serves the actual content once the gate clears a request. */
  serve?: (request: { url: string; method: string }) => Response | Promise<Response>;
}

const defaultServe = () =>
  new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

/**
 * The gate as an in-process vendor fetch — a drop-in replacement for
 * createMockVendor()/createRealVendor() anywhere a FetchLike vendor is
 * composed (guard tests, demos, the console world), with the gate's pricing,
 * screening, replay protection, and receipts in the loop.
 */
export function createGatedFetch(gate: Gate, options: GatedFetchOptions = {}): FetchLike {
  const serve = options.serve ?? defaultServe;

  return async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method =
      init?.method ?? (input instanceof Request ? input.method : 'GET');
    const headers = new Headers(
      init?.headers ?? (input instanceof Request ? input.headers : undefined),
    );

    const outcome = await gate.handle({ method, url, payment: headers.get('X-PAYMENT') });

    if (outcome.kind === 'open') return serve({ url, method });
    if (outcome.kind === 'paid') {
      const response = await serve({ url, method });
      const merged = new Headers(response.headers);
      merged.set('X-PAYMENT-RESPONSE', outcome.settlementHeader);
      return new Response(response.body, { status: response.status, headers: merged });
    }
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { 'content-type': 'application/json' },
    });
  };
}
