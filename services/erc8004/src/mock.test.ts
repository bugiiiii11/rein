import { describe, expect, it } from 'vitest';
import { formatErc8004Id } from '@reinconsole/core';
import { Erc8004Error } from './errors.js';
import { MockIdentityRegistry } from './mock.js';

const OWNER = '0xOwnerWallet0000000000000000000000000001';

describe('MockIdentityRegistry — the offline twin', () => {
  it('mints sequential tokenIds from 1 and formats the canonical id', () => {
    const registry = new MockIdentityRegistry();
    const first = registry.register({ owner: OWNER });
    const second = registry.register({ owner: OWNER });
    expect(first.tokenId).toBe(1n);
    expect(second.tokenId).toBe(2n);
    expect(first.erc8004Id).toBe(
      formatErc8004Id({
        chainId: registry.ref.chainId,
        registry: registry.ref.address,
        tokenId: 1n,
      }),
    );
  });

  it('agentWallet is auto-set to the owner at registration (reserved-key rule)', async () => {
    const registry = new MockIdentityRegistry();
    const { tokenId } = registry.register({ owner: OWNER });
    expect(await registry.agentWallet(tokenId)).toBe(OWNER);
    expect(await registry.ownerOf(tokenId)).toBe(OWNER);
  });

  it('setAgentWallet rotates the wallet without touching ownership', async () => {
    const registry = new MockIdentityRegistry();
    const { tokenId } = registry.register({ owner: OWNER });
    registry.setAgentWallet(tokenId, '0xRotated');
    expect(await registry.agentWallet(tokenId)).toBe('0xRotated');
    expect(await registry.ownerOf(tokenId)).toBe(OWNER);
  });

  it('ownerOf/agentURI throw unknown_agent for a nonexistent id; agentWallet mirrors the real zero-address read', async () => {
    const registry = new MockIdentityRegistry();
    await expect(registry.ownerOf(99n)).rejects.toMatchObject({ code: 'unknown_agent' });
    await expect(registry.agentURI(99n)).rejects.toMatchObject({ code: 'unknown_agent' });
    // The real getAgentWallet returns address(bytes20("")) — zero, never a revert.
    expect(await registry.agentWallet(99n)).toBeUndefined();
    expect(() => registry.setAgentWallet(99n, '0xW')).toThrow(Erc8004Error);
  });

  it('load() reinserts a known registration and future mints skip past it', async () => {
    const registry = new MockIdentityRegistry();
    registry.load({ tokenId: 7n, owner: OWNER, agentWallet: '0xRotated' });
    expect(await registry.ownerOf(7n)).toBe(OWNER);
    expect(await registry.agentWallet(7n)).toBe('0xRotated');
    const next = registry.register({ owner: '0xOther' });
    expect(next.tokenId).toBe(8n); // no collision with the hydrated id
  });

  it('a custom ref flows into every formatted id', () => {
    const registry = new MockIdentityRegistry({ chainId: 84532, address: '0xABCD000000000000000000000000000000000001' });
    const { erc8004Id } = registry.register({ owner: OWNER });
    expect(erc8004Id).toBe('eip155:84532:0xabcd000000000000000000000000000000000001/1');
  });

  it('agentURI returns the registered URI, or empty when none was set', async () => {
    const registry = new MockIdentityRegistry();
    const bare = registry.register({ owner: OWNER });
    const withUri = registry.register({ owner: OWNER, agentURI: 'data:application/json,{}' });
    expect(await registry.agentURI(bare.tokenId)).toBe('');
    expect(await registry.agentURI(withUri.tokenId)).toBe('data:application/json,{}');
  });
});
