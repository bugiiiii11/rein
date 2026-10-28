import { describe, it, expect } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { buildServer } from './server.js';
import { PolicyEngine } from './engine.js';
import { DecisionLog, keyIdOf } from './decision-log.js';

/**
 * S112: `/health` is where a verifier learns the keys. Before a rotation it
 * must look exactly as it did (plus `keyId`); after one it must say which key
 * signed which stretch, so a dump or an export can verify the old links.
 */
describe('GET /health signing keys', () => {
  const pem = (kp: ReturnType<typeof generateKeyPairSync>) =>
    kp.publicKey.export({ type: 'spki', format: 'pem' }).toString();

  it('serves the key id, and no retiredKeys on a chain that never rotated', async () => {
    const engine = new PolicyEngine();
    const body = (await buildServer(engine).inject({ method: 'GET', url: '/health' })).json();
    expect(body.keyId).toBe(keyIdOf(engine.publicKeyPem));
    expect(body).not.toHaveProperty('retiredKeys');
  });

  it('lists each retired key with the half-open stretch it signed', async () => {
    const a = generateKeyPairSync('ed25519');
    const b = generateKeyPairSync('ed25519');
    const log = new DecisionLog({ keyPair: b, retiredKeys: [{ publicKeyPem: pem(a), from: 0 }], keyFrom: 7 });
    const body = (await buildServer(new PolicyEngine({ log })).inject({ method: 'GET', url: '/health' })).json();
    expect(body.publicKey).toBe(pem(b));
    expect(body.retiredKeys).toEqual([{ publicKey: pem(a), keyId: keyIdOf(pem(a)), from: 0, until: 7 }]);
  });
});
