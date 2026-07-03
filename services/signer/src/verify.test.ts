import { describe, it, expect } from 'vitest';
import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { Decision, PaymentIntent } from '@reinconsole/core';
import { intentHashOf, verifyVoucher } from './verify.js';
import { evaluateFor, makeEngine } from './testkit.js';

function engineKey(pem: string) {
  return createPublicKey(pem);
}

describe('verifyVoucher', () => {
  it('accepts a genuine {intent, decision} pair from the engine', async () => {
    const { engine, agentId } = await makeEngine();
    const { intent, decision } = await evaluateFor(engine, agentId);
    expect(decision.intentHash).toBe(intentHashOf(intent));
    expect(verifyVoucher(intent, decision, engineKey(engine.publicKeyPem))).toEqual({ ok: true });
  });

  it('still verifies after a JSON round-trip (the HTTP wire path)', async () => {
    const { engine, agentId } = await makeEngine();
    const { intent, decision } = await evaluateFor(engine, agentId);
    const wireIntent = PaymentIntent.parse(JSON.parse(JSON.stringify(intent)));
    const wireDecision = Decision.parse(JSON.parse(JSON.stringify(decision)));
    expect(verifyVoucher(wireIntent, wireDecision, engineKey(engine.publicKeyPem))).toEqual({
      ok: true,
    });
  });

  it('rejects an intent whose amount was inflated after the decision', async () => {
    const { engine, agentId } = await makeEngine();
    const { intent, decision } = await evaluateFor(engine, agentId);
    const forged = { ...intent, amount: '100.00' };
    const check = verifyVoucher(forged, decision, engineKey(engine.publicKeyPem));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/intent content/);
  });

  it('rejects an intent whose recipient was swapped after the decision', async () => {
    const { engine, agentId } = await makeEngine();
    const { intent, decision } = await evaluateFor(engine, agentId);
    const forged = {
      ...intent,
      vendor: { ...intent.vendor, address: '0x2222222222222222222222222222222222222222' },
    };
    expect(verifyVoucher(forged, decision, engineKey(engine.publicKeyPem)).ok).toBe(false);
  });

  it('rejects a decision whose outcome was flipped', async () => {
    const { engine, agentId } = await makeEngine();
    // 5.00 is over the 1.00 cap -> deny.
    const { intent, decision } = await evaluateFor(engine, agentId, { amount: '5.00' });
    expect(decision.outcome).toBe('deny');
    const flipped = { ...decision, outcome: 'allow' as const };
    const check = verifyVoucher(intent, flipped, engineKey(engine.publicKeyPem));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/hash/);
  });

  it('rejects a self-signed decision (right hash, wrong key)', async () => {
    const { engine, agentId } = await makeEngine();
    const { intent, decision } = await evaluateFor(engine, agentId);
    const other = generateKeyPairSync('ed25519');
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    // The attacker can recompute hashes but cannot sign as the engine.
    const check = verifyVoucher(intent, decision, engineKey(otherPem));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/signature/);
  });

  it('rejects a decision paired with a different intent', async () => {
    const { engine, agentId } = await makeEngine();
    const first = await evaluateFor(engine, agentId);
    const second = await evaluateFor(engine, agentId);
    const check = verifyVoucher(second.intent, first.decision, engineKey(engine.publicKeyPem));
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.reason).toMatch(/different intent/);
  });
});
