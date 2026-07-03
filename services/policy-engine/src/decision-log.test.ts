import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { DecisionLog, verifyDecisionChain } from './decision-log.js';
import { newId, type Decision } from '@reinconsole/core';

function input(i: number) {
  return {
    intentId: newId('int'),
    intentHash: `ih-${i}`,
    outcome: (i % 2 === 0 ? 'allow' : 'deny') as 'allow' | 'deny',
    matchedRules: [`rule-${i}`],
    reason: `r${i}`,
    policyId: 'pol_x',
    policyVersion: '1',
    latencyMs: i,
  };
}

async function appendSome(log: DecisionLog, n: number) {
  for (let i = 0; i < n; i++) await log.append(input(i));
}

describe('DecisionLog', () => {
  it('produces a verifiable hash chain', async () => {
    const log = new DecisionLog();
    await appendSome(log, 5);
    const all = log.all();
    expect(all).toHaveLength(5);
    expect(all[0]!.prevHash).toBe('genesis');
    expect(all[1]!.prevHash).toBe(all[0]!.hash);
    expect(verifyDecisionChain(all, log.publicKeyPem)).toBe(true);
  });

  it('detects tampering with a decision', async () => {
    const log = new DecisionLog();
    await appendSome(log, 3);
    const tampered = log.all().map((d) => ({ ...d }));
    tampered[1]!.outcome = tampered[1]!.outcome === 'allow' ? 'deny' : 'allow';
    expect(verifyDecisionChain(tampered, log.publicKeyPem)).toBe(false);
  });

  it('rejects signatures from a different key', async () => {
    const log = new DecisionLog();
    await appendSome(log, 2);
    const other = generateKeyPairSync('ed25519');
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(verifyDecisionChain(log.all(), otherPem)).toBe(false);
  });

  it('does not fork the chain under concurrent appends', async () => {
    const log = new DecisionLog();
    await Promise.all(Array.from({ length: 8 }, (_, i) => log.append(input(i))));
    expect(log.all()).toHaveLength(8);
    expect(verifyDecisionChain(log.all(), log.publicKeyPem)).toBe(true);
  });

  it('resumes a persisted chain with the same key and stays verifiable', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const persisted: Decision[] = [];

    const first = new DecisionLog({ keyPair, persist: (d) => void persisted.push(d) });
    await appendSome(first, 3);

    // "Restart": a new log resumes from what the sink captured.
    const second = new DecisionLog({ keyPair, resume: [...persisted], persist: (d) => void persisted.push(d) });
    await second.append(input(3));

    expect(second.all()).toHaveLength(4);
    expect(second.all()[3]!.prevHash).toBe(persisted[2]!.hash);
    expect(verifyDecisionChain(second.all(), first.publicKeyPem)).toBe(true);
    expect(second.publicKeyPem).toBe(first.publicKeyPem);
  });

  it('does not advance the chain when the durable sink throws', async () => {
    let fail = true;
    const log = new DecisionLog({
      persist: () => {
        if (fail) throw new Error('disk on fire');
      },
    });
    await expect(log.append(input(0))).rejects.toThrow('disk on fire');
    expect(log.all()).toHaveLength(0);

    fail = false;
    const d = await log.append(input(1));
    expect(d.prevHash).toBe('genesis'); // the failed append left no trace
    expect(verifyDecisionChain(log.all(), log.publicKeyPem)).toBe(true);
  });
});
