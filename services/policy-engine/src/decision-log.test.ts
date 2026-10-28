import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { DecisionLog, chainBreakAt, keyIdOf, verifyDecisionChain } from './decision-log.js';
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

  it('says WHERE a chain breaks, not just that it does', async () => {
    const log = new DecisionLog();
    await appendSome(log, 4);
    expect(chainBreakAt(log.all(), log.publicKeyPem)).toBeUndefined();

    const tampered = log.all().map((d) => ({ ...d }));
    tampered[2]!.outcome = tampered[2]!.outcome === 'allow' ? 'deny' : 'allow';
    expect(chainBreakAt(tampered, log.publicKeyPem)).toBe(2);

    const other = generateKeyPairSync('ed25519');
    const otherPem = other.publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(chainBreakAt(log.all(), otherPem)).toBe(0);
  });

  it('verifies its own chain incrementally and never forgets a break', async () => {
    const keyPair = generateKeyPairSync('ed25519');
    const signed = new DecisionLog({ keyPair });
    await appendSome(signed, 3);

    const at = new Date('2026-10-02T01:44:52.000Z');
    expect(signed.verify(at)).toEqual({ intact: true, length: 3, verifiedAt: at });
    // The next call walks only what was appended since: the verdict grows with the chain.
    await signed.append(input(3));
    expect(signed.verify(at)).toMatchObject({ intact: true, length: 4 });

    // A resumed chain is verified on the FIRST call -- the check the store does not make on open.
    const tampered = signed.all().map((d) => ({ ...d }));
    tampered[1]!.outcome = tampered[1]!.outcome === 'allow' ? 'deny' : 'allow';
    const resumed = new DecisionLog({ keyPair, resume: tampered });
    expect(resumed.verify(at)).toEqual({ intact: false, brokenAt: 1, length: 4, verifiedAt: at });
    // Appending past a break does not heal it: the index is remembered.
    await resumed.append(input(4));
    expect(resumed.verify(at)).toMatchObject({ intact: false, brokenAt: 1, length: 5 });

    // And a chain signed by another key breaks at its first link.
    const foreign = new DecisionLog({ resume: signed.all() });
    expect(foreign.verify(at)).toMatchObject({ intact: false, brokenAt: 0 });
  });
});

describe('key rotation (S112)', () => {
  const pairOf = () => generateKeyPairSync('ed25519');
  const pem = (kp: ReturnType<typeof pairOf>) =>
    kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  async function rotated() {
    const a = pairOf();
    const b = pairOf();
    const logA = new DecisionLog({ keyPair: a });
    await appendSome(logA, 3);
    const logB = new DecisionLog({
      keyPair: b,
      resume: logA.all(),
      retiredKeys: [{ publicKeyPem: pem(a), from: 0 }],
      keyFrom: 3,
    });
    await appendSome(logB, 2);
    return { a, b, logB };
  }

  it('verifies each link under the key that covers its index, and no other', async () => {
    const { a, b, logB } = await rotated();
    const chain = logB.all();
    expect(chain[3]!.prevHash).toBe(chain[2]!.hash);
    expect(logB.verify().intact).toBe(true);
    expect(verifyDecisionChain(chain, logB.keySchedule)).toBe(true);
    expect(chainBreakAt(chain, pem(a))).toBe(3);
    expect(chainBreakAt(chain, pem(b))).toBe(0);
  });

  it('rejects a link the retired key signed past its stretch -- the forgery a rotation stops', async () => {
    const { a, logB } = await rotated();
    // Whoever holds the leaked key A forks the chain at the rotation point and
    // appends under A: a well-formed link, correctly hashed and linked.
    const forger = new DecisionLog({ keyPair: a, resume: logB.all().slice(0, 3) });
    await forger.append(input(9));
    expect(chainBreakAt(forger.all(), logB.keySchedule)).toBe(3);
  });

  it('refuses a schedule that leaves an index with no key or two', () => {
    const k = pem(pairOf());
    expect(() => chainBreakAt([], [{ publicKeyPem: k, from: 1 }])).toThrow(/start at index 0/);
    expect(() =>
      chainBreakAt([], [
        { publicKeyPem: k, from: 0 },
        { publicKeyPem: k, from: 0 },
      ]),
    ).toThrow(/strictly increasing/);
    expect(() => new DecisionLog({ retiredKeys: [{ publicKeyPem: k, from: 0 }] })).toThrow(/keyFrom/);
  });

  it('ids a key by its DER, whatever the PEM text looks like', () => {
    const k = pem(pairOf());
    expect(keyIdOf(k)).toMatch(/^[0-9a-f]{64}$/);
    expect(keyIdOf(k.replace(/\n/g, '\r\n'))).toBe(keyIdOf(k));
  });
});
