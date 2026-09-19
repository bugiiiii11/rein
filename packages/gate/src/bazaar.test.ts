/**
 * Bazaar discovery: a route's machine-readable listing, riding the v2 402
 * (Sprint 5.4).
 *
 * The premise is that the 402 IS the listing — an agent that has never seen a
 * vendor can read what a route takes and returns and decide whether to buy,
 * with no human in the loop and no second endpoint. So the tests care about
 * two things: that the metadata reaches the wire where a crawler reads it,
 * and that it never reaches anywhere it would break an existing client.
 */
import { describe, expect, it } from 'vitest';
import { createGate, bazaarExtension, type GateOutcome, type GateRails } from './index.js';
import { parsePaymentRequiredHeader } from '@reinconsole/sdk';

const VENDOR = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const INPUT = { type: 'object', properties: { host: { type: 'string' } }, required: ['host'] };
const OUTPUT = { type: 'object', properties: { score: { type: 'number' } } };

const stubRails = (): GateRails => ({
  verify: async () => undefined,
  settle: async () => ({ header: 'x', transaction: '0xtx', network: 'base-sepolia', payer: '0x0' }),
});

function gateWith(route: Record<string, unknown>, advertiseV2 = true) {
  return createGate({
    routes: [{ path: '/v1/scores/*', price: '0.005', ...route } as never],
    rails: stubRails(),
    payTo: VENDOR,
    network: 'base-sepolia',
    asset: ASSET,
    advertiseV2,
  });
}

async function quote(gate: ReturnType<typeof createGate>): Promise<GateOutcome> {
  return gate.handle({
    method: 'GET',
    url: 'https://api.vendor.test/v1/scores/vendor/example.com',
    payment: null,
  });
}

function extensionsOf(outcome: GateOutcome): Record<string, unknown> | undefined {
  const header =
    outcome.kind === 'quote' || outcome.kind === 'refused'
      ? outcome.paymentRequiredHeader
      : undefined;
  return parsePaymentRequiredHeader(header ?? null)?.extensions;
}

describe('bazaarExtension', () => {
  it('is empty for a route that declares nothing', () => {
    expect(bazaarExtension(undefined)).toEqual({});
    expect(bazaarExtension({ path: '/x', price: '0.01' })).toEqual({});
    // An empty `discovery` is the same as none: a crawler must not have to
    // special-case a `bazaar` key with nothing in it.
    expect(bazaarExtension({ path: '/x', price: '0.01', discovery: {} })).toEqual({});
  });

  it('splits what a human reads from what a client codes against', () => {
    const ext = bazaarExtension({
      path: '/v1/scores/*',
      method: 'get',
      price: '0.005',
      description: 'reputation lookup',
      mimeType: 'application/json',
      discovery: { input: INPUT, output: OUTPUT },
    }) as { bazaar: { info: Record<string, unknown>; schema: Record<string, unknown> } };

    expect(ext.bazaar.info).toEqual({
      description: 'reputation lookup',
      mimeType: 'application/json',
      method: 'GET',
      path: '/v1/scores/*',
    });
    expect(ext.bazaar.schema).toEqual({ input: INPUT, output: OUTPUT });
  });

  it('carries whichever half the route declared', () => {
    const outputOnly = bazaarExtension({
      path: '/x',
      price: '0.01',
      discovery: { output: OUTPUT },
    }) as { bazaar: { schema: Record<string, unknown> } };
    expect(outputOnly.bazaar.schema).toEqual({ output: OUTPUT });
    expect(outputOnly.bazaar.schema.input).toBeUndefined();
  });

  it('reports a method-less route as pricing every method, not as GET', () => {
    const ext = bazaarExtension({
      path: '/x',
      price: '0.01',
      discovery: { input: INPUT },
    }) as { bazaar: { info: { method: string } } };
    expect(ext.bazaar.info.method).toBe('ANY');
  });
});

describe('discovery on the wire', () => {
  it('rides the v2 402 a crawler reads', async () => {
    const outcome = await quote(gateWith({ discovery: { input: INPUT, output: OUTPUT } }));
    expect(outcome.kind).toBe('quote');
    const extensions = extensionsOf(outcome) as { bazaar: { schema: unknown } };
    expect(extensions.bazaar.schema).toEqual({ input: INPUT, output: OUTPUT });
  });

  it('leaves extensions empty when the route declares no discovery', async () => {
    const extensions = extensionsOf(await quote(gateWith({})));
    expect(extensions).toEqual({});
  });

  /**
   * The v1 body has no extension slot. Inventing one would break the parser
   * of every published v1 client — the listing is worth having, but not at
   * the cost of the dialect most payers still speak.
   */
  it('never touches the v1 body', async () => {
    const outcome = await quote(gateWith({ discovery: { input: INPUT, output: OUTPUT } }));
    if (outcome.kind !== 'quote') throw new Error('expected a quote');
    expect(JSON.stringify(outcome.body)).not.toContain('bazaar');
    expect(Object.keys(outcome.body)).toEqual(['x402Version', 'accepts', 'error']);
  });

  it('advertises nothing at all without advertiseV2', async () => {
    const outcome = await quote(gateWith({ discovery: { input: INPUT } }, false));
    if (outcome.kind !== 'quote') throw new Error('expected a quote');
    expect(outcome.paymentRequiredHeader).toBeUndefined();
  });

  /**
   * A re-quote is the 402 a payer sees after a rejected payment, and it is
   * the one a crawler is most likely to hit while probing. It must carry the
   * same listing as the first quote, or discovery would depend on getting the
   * payment wrong.
   */
  it('carries the same listing on a refusal re-quote', async () => {
    const gate = gateWith({ discovery: { input: INPUT, output: OUTPUT } });
    const outcome = await gate.handle({
      method: 'GET',
      url: 'https://api.vendor.test/v1/scores/vendor/example.com',
      // Garbage in the payment slot: refused, and re-quoted per the spec.
      payment: Buffer.from(JSON.stringify({ not: 'a payment' })).toString('base64'),
    });
    expect(outcome.kind).toBe('refused');
    const extensions = extensionsOf(outcome) as { bazaar: { schema: unknown } };
    expect(extensions.bazaar.schema).toEqual({ input: INPUT, output: OUTPUT });
  });

  /**
   * The gate advertises the schema and enforces nothing against it. That is
   * deliberate: a gate that checked would be asserting the handler matches
   * its own listing, which it cannot know. Better an honest advertisement
   * than a guarantee the gate is in no position to make.
   */
  it('does not police the declared schema', async () => {
    const gate = gateWith({ discovery: { input: { nonsense: true }, output: 'not a schema' } });
    const outcome = await quote(gate);
    expect(outcome.kind).toBe('quote');
    const extensions = extensionsOf(outcome) as { bazaar: { schema: Record<string, unknown> } };
    expect(extensions.bazaar.schema.output).toBe('not a schema');
  });
});
