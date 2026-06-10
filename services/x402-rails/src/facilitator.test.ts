import { describe, it, expect } from 'vitest';
import type { FetchLike, PaymentRequirement } from '@rein/sdk';
import { PaymentRequirement as Requirement } from '@rein/sdk';
import { FacilitatorHttpError } from './errors.js';
import { FacilitatorClient } from './facilitator.js';
import type { PaymentPayload } from './wire.js';

const payload: PaymentPayload = {
  x402Version: 1,
  scheme: 'exact',
  network: 'base-sepolia',
  payload: {
    signature: `0x${'ab'.repeat(65)}`,
    authorization: {
      from: '0x1111111111111111111111111111111111111111',
      to: '0x2222222222222222222222222222222222222222',
      value: '10000',
      validAfter: '1749999400',
      validBefore: '1750000300',
      nonce: `0x${'cd'.repeat(32)}`,
    },
  },
};

const requirement: PaymentRequirement = Requirement.parse({
  scheme: 'exact',
  network: 'base-sepolia',
  maxAmountRequired: '10000',
  resource: 'https://api.vendor.test/v1/answer',
  description: '',
  mimeType: 'application/json',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  extra: { name: 'USDC', version: '2' },
});

interface Seen {
  url: string;
  method: string | undefined;
  body: unknown;
}

function stub(responses: Record<string, unknown>): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: FetchLike = (input, init) => {
    const url = String(input);
    seen.push({
      url,
      method: init?.method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    });
    const path = new URL(url).pathname.split('/').at(-1) ?? '';
    const body = responses[path];
    if (body === undefined) return Promise.resolve(new Response('not found', { status: 404 }));
    return Promise.resolve(
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, seen };
}

describe('FacilitatorClient', () => {
  it('POSTs the v1 envelope: decoded payload, singular requirement', async () => {
    const { fetch, seen } = stub({ verify: { isValid: true, payer: payload.payload.authorization.from } });
    const client = new FacilitatorClient({ url: 'https://fac.test/facilitator/', fetch });

    const res = await client.verify(payload, requirement);

    expect(res.isValid).toBe(true);
    expect(seen[0]?.url).toBe('https://fac.test/facilitator/verify');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.body).toEqual({
      x402Version: 1,
      paymentPayload: payload,
      paymentRequirements: requirement,
    });
  });

  it('parses a settle response (transaction + network)', async () => {
    const tx = `0x${'12'.repeat(32)}`;
    const { fetch, seen } = stub({
      settle: { success: true, transaction: tx, network: 'base-sepolia' },
    });
    const client = new FacilitatorClient({ url: 'https://fac.test', fetch });

    const res = await client.settle(payload, requirement);

    expect(res).toMatchObject({ success: true, transaction: tx, network: 'base-sepolia' });
    expect(seen[0]?.url).toBe('https://fac.test/settle');
  });

  it('throws FacilitatorHttpError on non-2xx, keeping the body', async () => {
    const fetch: FetchLike = () =>
      Promise.resolve(new Response('invalid_exact_evm_payload', { status: 400 }));
    const client = new FacilitatorClient({ url: 'https://fac.test', fetch });

    await expect(client.settle(payload, requirement)).rejects.toThrowError(FacilitatorHttpError);
    await client.settle(payload, requirement).catch((e: unknown) => {
      expect(e).toMatchObject({ status: 400, body: 'invalid_exact_evm_payload' });
    });
  });

  it('GETs /supported', async () => {
    const kinds = { kinds: [{ x402Version: 1, scheme: 'exact', network: 'base-sepolia' }] };
    const { fetch, seen } = stub({ supported: kinds });
    const client = new FacilitatorClient({ url: 'https://fac.test', fetch });

    expect(await client.supported()).toEqual(kinds);
    expect(seen[0]?.method).toBeUndefined();
  });
});
