import { describe, expect, it } from 'vitest';
import { Erc8004Error } from './errors.js';
import { agentLinkPairs, vendorLinkPairs } from './links.js';

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
