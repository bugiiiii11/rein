import { newId, type Decision, type PaymentIntent } from '@rein/core';
import { PolicyEngine, type IntentInput } from '@rein/policy-engine';
import type { PaymentRequirement } from '@rein/sdk';
import { BASE_SEPOLIA_USDC } from '@rein/x402-rails';

/**
 * Shared fixtures for signer tests: a real policy engine issuing real signed
 * vouchers, and a requirement/intent pair that satisfies every gate so each
 * test can break exactly one thing.
 */

export const VENDOR_ADDRESS = '0x1111111111111111111111111111111111111111';
export const VENDOR_HOST = 'api.vendor.test';

/** An engine with one policy: allow anything up to 1.00 USDC. */
export async function makeEngine(): Promise<{ engine: PolicyEngine; agentId: string }> {
  const engine = new PolicyEngine();
  const agent = await engine.registerAgent({
    id: newId('agt'),
    orgId: newId('org'),
    name: 'signer-test-agent',
    wallets: [],
    status: 'active',
    createdAt: new Date(),
  });
  await engine.addPolicy({
    policyId: 'pol_signer_test',
    appliesTo: {},
    rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
    default: 'allow',
  });
  return { engine, agentId: agent.id };
}

/** A v1-valid exact-EVM requirement matching {@link evaluateFor}'s intent. */
export function makeRequirement(overrides: Partial<PaymentRequirement> = {}): PaymentRequirement {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000', // 0.01 USDC at 6 decimals
    resource: `https://${VENDOR_HOST}/v1/answer`,
    description: 'an answer',
    mimeType: 'application/json',
    payTo: VENDOR_ADDRESS,
    maxTimeoutSeconds: 300,
    asset: BASE_SEPOLIA_USDC,
    ...overrides,
  };
}

/** Evaluate a matching intent and return the engine-signed voucher pair. */
export function evaluateFor(
  engine: PolicyEngine,
  agentId: string,
  overrides: Partial<IntentInput> = {},
): Promise<{ intent: PaymentIntent; decision: Decision }> {
  return engine.evaluateIntent({
    agentId,
    vendor: { host: VENDOR_HOST, address: VENDOR_ADDRESS },
    resource: '/v1/answer',
    amount: '0.01',
    asset: 'USDC',
    chain: 'base',
    ...overrides,
  });
}
