import { describe, expect, it } from 'vitest';
import type { ReputationSubject } from '@reinconsole/core';
import { Erc8004Error } from './errors.js';
import { agentLinkPairs, linkAgentFromRegistry, vendorLinkPairs } from './links.js';
import { MockIdentityRegistry } from './mock.js';

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e';
const CHECKSUMMED = `eip155:84532:${REGISTRY}/42`;
const CANONICAL = 'eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e/42';
const ULID = 'agt_01JTESTAGENT0000000000000';

describe('agentLinkPairs — pure derivation, erc8004-canonical', () => {
  it('canonical is the parse->format normalized id; aliases are localId then wallets', () => {
    const pairs = agentLinkPairs({ erc8004Id: CHECKSUMMED, localId: ULID, wallets: ['0xW1', '0xW2'] });
    expect(pairs.map((p) => p.canonical.id)).toEqual([CANONICAL, CANONICAL, CANONICAL]);
    expect(pairs.map((p) => p.alias)).toEqual([
      { kind: 'agent', id: ULID },
      { kind: 'agent', id: '0xW1' },
      { kind: 'agent', id: '0xW2' },
    ]);
  });

  it('dedupes wallets across casing (0x ids are case-insensitive subjects)', () => {
    const pairs = agentLinkPairs({ erc8004Id: CANONICAL, wallets: ['0xWALLET', '0xwallet'] });
    expect(pairs).toHaveLength(1);
  });

  it('drops a self-pair (an alias equal to the canonical id)', () => {
    const pairs = agentLinkPairs({ erc8004Id: CANONICAL, localId: CANONICAL });
    expect(pairs).toHaveLength(0);
  });

  it('no localId means wallet aliases only', () => {
    const pairs = agentLinkPairs({ erc8004Id: CANONICAL, wallets: ['0xW1'] });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.alias.id).toBe('0xW1');
  });

  it('throws bad_id on an unparseable erc8004Id', () => {
    expect(() => agentLinkPairs({ erc8004Id: 'not-an-id' })).toThrow(Erc8004Error);
  });
});

describe('vendorLinkPairs — hosts stay canonical', () => {
  it('the host is canonical; identity id and wallets fold into it', () => {
    const pairs = vendorLinkPairs({
      host: 'api.data.test',
      erc8004Id: CHECKSUMMED,
      wallets: ['0xTreasury'],
    });
    expect(pairs.map((p) => p.canonical)).toEqual([
      { kind: 'vendor', id: 'api.data.test' },
      { kind: 'vendor', id: 'api.data.test' },
    ]);
    expect(pairs.map((p) => p.alias.id)).toEqual([CANONICAL, '0xTreasury']);
  });

  it('no identity and no wallets means nothing to assert', () => {
    expect(vendorLinkPairs({ host: 'api.data.test' })).toHaveLength(0);
  });

  it('an unparseable vendor erc8004Id is skipped, wallets still link', () => {
    const pairs = vendorLinkPairs({ host: 'api.data.test', erc8004Id: 'junk', wallets: ['0xT'] });
    expect(pairs).toHaveLength(1);
    expect(pairs[0]?.alias.id).toBe('0xT');
  });

  it('dedupes vendor aliases case-insensitively (vendor ids always lowercase)', () => {
    const pairs = vendorLinkPairs({ host: 'api.data.test', wallets: ['0xTREASURY', '0xtreasury'] });
    expect(pairs).toHaveLength(1);
  });
});

// ── entitlement gating (the multi-tenant claim gate) ─────────────────────────

const OWNER = '0xOwnerWallet0000000000000000000000000001';

function recordingSink() {
  const links: { canonical: ReputationSubject; alias: ReputationSubject }[] = [];
  return { links, link: (canonical: ReputationSubject, alias: ReputationSubject) => void links.push({ canonical, alias }) };
}

describe("linkAgentFromRegistry — entitlement: 'wallet'", () => {
  it('a doc holding the owner wallet merges (case-insensitive)', async () => {
    const registry = new MockIdentityRegistry();
    const { tokenId, erc8004Id } = registry.register({ owner: OWNER });
    const sink = recordingSink();
    const linked = await linkAgentFromRegistry(
      sink,
      registry,
      { id: ULID, erc8004Id, wallets: [{ address: OWNER.toUpperCase().replace('0X', '0x') }] },
      { entitlement: 'wallet' },
    );
    expect(linked.source).toBe('erc8004');
    expect(linked.entitled).toBeUndefined();
    expect(linked.canonical.id).toBe(registry.idOf(tokenId));
  });

  it('a doc holding only the rotated agentWallet still merges', async () => {
    const registry = new MockIdentityRegistry();
    const { tokenId, erc8004Id } = registry.register({ owner: OWNER });
    registry.setAgentWallet(tokenId, '0xSessionKey0000000000000000000000000002');
    const sink = recordingSink();
    const linked = await linkAgentFromRegistry(
      sink,
      registry,
      { id: ULID, erc8004Id, wallets: [{ address: '0xSESSIONKEY0000000000000000000000000002' }] },
      { entitlement: 'wallet' },
    );
    expect(linked.source).toBe('erc8004');
  });

  it('a doc claiming an identity whose wallets it does NOT hold is refused to local', async () => {
    const registry = new MockIdentityRegistry();
    const { erc8004Id } = registry.register({ owner: OWNER });
    const sink = recordingSink();
    const linked = await linkAgentFromRegistry(
      sink,
      registry,
      { id: ULID, erc8004Id, wallets: [{ address: '0xSomeoneElse000000000000000000000000003' }] },
      { entitlement: 'wallet' },
    );
    expect(linked).toMatchObject({ source: 'local', entitled: false });
    // Local semantics: the ULID stays canonical; NOTHING folds into the claimed identity.
    expect(linked.canonical).toEqual({ kind: 'agent', id: ULID });
    expect(sink.links.every((l) => l.canonical.id === ULID)).toBe(true);
  });

  it('a doc with no wallets at all cannot prove a claim — refused to local', async () => {
    const registry = new MockIdentityRegistry();
    const { erc8004Id } = registry.register({ owner: OWNER });
    const linked = await linkAgentFromRegistry(
      recordingSink(),
      registry,
      { id: ULID, erc8004Id, wallets: [] },
      { entitlement: 'wallet' },
    );
    expect(linked).toMatchObject({ source: 'local', entitled: false });
  });

  it("the default ('open') keeps single-trust-domain semantics: unproven claims merge", async () => {
    const registry = new MockIdentityRegistry();
    const { tokenId, erc8004Id } = registry.register({ owner: OWNER });
    const linked = await linkAgentFromRegistry(recordingSink(), registry, {
      id: ULID,
      erc8004Id,
      wallets: [{ address: '0xSomeoneElse000000000000000000000000003' }],
    });
    expect(linked.source).toBe('erc8004');
    expect(linked.canonical.id).toBe(registry.idOf(tokenId));
  });

  it('the lenient fallbacks stay UN-flagged: no erc8004Id is "no claim", not "refused"', async () => {
    const registry = new MockIdentityRegistry();
    const linked = await linkAgentFromRegistry(
      recordingSink(),
      registry,
      { id: ULID, wallets: [{ address: '0xW1' }] },
      { entitlement: 'wallet' },
    );
    expect(linked.source).toBe('local');
    expect(linked.entitled).toBeUndefined();
  });
});
