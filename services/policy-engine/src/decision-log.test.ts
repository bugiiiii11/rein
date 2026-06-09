import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { DecisionLog, verifyDecisionChain } from './decision-log.js';
import { newId } from '@rein/core';

function appendSome(log: DecisionLog, n: number) {
  for (let i = 0; i < n; i++) {
    log.append({
      intentId: newId('int'),
      outcome: i % 2 === 0 ? 'allow' : 'deny',
      matchedRules: [`rule-${i}`],
      reason: `r${i}`,
      policyId: 'pol_x',
      policyVersion: '1',
      latencyMs: i,
    });
  }
}

describe('DecisionLog', () => {
  it('produces a verifiable hash chain', () => {
    const log = new DecisionLog();
    appendSome(log, 5);
    const all = log.all();
    expect(all).toHaveLength(5);
    expect(all[0]!.prevHash).toBe('genesis');
    expect(all[1]!.prevHash).toBe(all[0]!.hash);
    expect(verifyDecisionChain(all, log.publicKeyPem)).toBe(true);
  });

  it('detects tampering with a decision', () => {
    const log = new DecisionLog();
    appendSome(log, 3);
    const tampered = log.all().map((d) => ({ ...d }));
    tampered[1]!.outcome = tampered[1]!.outcome === 'allow' ? 'deny' : 'allow';
    expect(verifyDecisionChain(tampered, log.publicKeyPem)).toBe(false);
  });

  it('rejects signatures from a different key', () => {
    const log = new DecisionLog();
    appendSome(log, 2);
    const other = generateKeyPairSync('ed25519');
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyDecisionChain(log.all(), otherPem)).toBe(false);
  });
});
