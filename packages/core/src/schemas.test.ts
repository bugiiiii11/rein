import { describe, it, expect } from 'vitest';
import { newId } from './ulid.js';
import { Agent } from './agent.js';
import { PaymentIntent } from './intent.js';
import { Decision } from './decision.js';
import { ReinEvent } from './events.js';

describe('Agent schema', () => {
  it('parses a valid agent and applies defaults', () => {
    const agent = Agent.parse({
      id: newId('agt'),
      orgId: newId('org'),
      name: 'Research Agent',
      createdAt: new Date().toISOString(),
    });
    expect(agent.status).toBe('active');
    expect(agent.wallets).toEqual([]);
  });
});

describe('PaymentIntent schema', () => {
  it('round-trips a realistic x402 intent', () => {
    const intent = PaymentIntent.parse({
      id: newId('int'),
      agentId: newId('agt'),
      vendor: { host: 'api.vendor.com', address: '0xabc' },
      resource: 'https://api.vendor.com/v1/answer?q=...',
      amount: '0.01',
      asset: 'USDC',
      chain: 'base',
      nonce: 'n-123',
      createdAt: new Date(),
    });
    expect(intent.amount).toBe('0.01');
    expect(intent.taskContext).toEqual({});
  });

  it('rejects a float-shaped amount', () => {
    const bad = {
      id: newId('int'),
      agentId: newId('agt'),
      vendor: { host: 'h', address: 'a' },
      resource: 'r',
      amount: 0.01 as unknown as string,
      asset: 'USDC',
      chain: 'base',
      nonce: 'n',
      createdAt: new Date(),
    };
    expect(PaymentIntent.safeParse(bad).success).toBe(false);
  });
});

describe('ReinEvent discriminated union', () => {
  it('validates a decision.made event', () => {
    const decision = Decision.parse({
      id: newId('dec'),
      intentId: newId('int'),
      outcome: 'allow',
      policyId: 'pol_x',
      policyVersion: '1',
      prevHash: 'genesis',
      hash: 'h1',
      signature: 'sig',
      latencyMs: 12,
      decidedAt: new Date(),
    });
    const event = ReinEvent.parse({ type: 'decision.made', at: new Date(), decision });
    expect(event.type).toBe('decision.made');
  });

  it('validates a shadow.spend bypass event', () => {
    const event = ReinEvent.parse({
      type: 'shadow.spend',
      at: new Date(),
      agentId: newId('agt'),
      txHash: '0xdeadbeef',
      chain: 'base',
      amount: '2.50',
    });
    expect(event.type).toBe('shadow.spend');
  });
});
