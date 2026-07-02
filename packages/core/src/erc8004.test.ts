import { describe, expect, it } from 'vitest';
import { Erc8004Id, formatErc8004Id, parseErc8004Id } from './erc8004.js';

const REGISTRY = '0x8004A818BFB912233c491871b3d84c89A494BD9e'; // checksummed on purpose

describe('erc8004 canonical id', () => {
  it('format lowercases a checksummed registry address', () => {
    const id = formatErc8004Id({ chainId: 84532, registry: REGISTRY, tokenId: 42n });
    expect(id).toBe('eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e/42');
  });

  it('parse -> format is a fixed point (the normalization contract)', () => {
    const id = formatErc8004Id({ chainId: 8453, registry: REGISTRY, tokenId: 1n });
    const ref = parseErc8004Id(id);
    expect(ref).toBeDefined();
    expect(formatErc8004Id(ref!)).toBe(id);
  });

  it('parse accepts mixed-case addresses and normalizes to lowercase', () => {
    const ref = parseErc8004Id(`eip155:1:${REGISTRY}/7`);
    expect(ref).toEqual({
      chainId: 1,
      registry: REGISTRY.toLowerCase(),
      tokenId: 7n,
    });
  });

  it('tokenIds beyond 2^53 roundtrip via bigint', () => {
    const big = 123456789012345678901234567890n;
    const id = formatErc8004Id({ chainId: 1, registry: REGISTRY, tokenId: big });
    expect(parseErc8004Id(id)?.tokenId).toBe(big);
  });

  it('parse rejects malformed strings', () => {
    for (const bad of [
      '',
      'eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e', // no tokenId
      `eip155:84532:${REGISTRY}/`, // empty tokenId
      `eip155:84532:${REGISTRY}/x1`, // non-numeric tokenId
      `eip155::${REGISTRY}/1`, // missing chainId
      `eip155:0:${REGISTRY}/1`, // chainId < 1
      'eip155:84532:8004a818bfb912233c491871b3d84c89a494bd9e/1', // no 0x
      `eip155:84532:${REGISTRY.slice(0, -2)}/1`, // short address
      `eip155:84532:${REGISTRY}/1/2`, // extra segment
      `cosmos:84532:${REGISTRY}/1`, // wrong namespace
      `eip155:99999999999999999999:${REGISTRY}/1`, // chainId overflows safe int
    ]) {
      expect(parseErc8004Id(bad), bad).toBeUndefined();
    }
  });

  it('format throws on malformed refs instead of minting unparseable ids', () => {
    expect(() => formatErc8004Id({ chainId: 0, registry: REGISTRY, tokenId: 1n })).toThrow(RangeError);
    expect(() => formatErc8004Id({ chainId: 1.5, registry: REGISTRY, tokenId: 1n })).toThrow(RangeError);
    expect(() => formatErc8004Id({ chainId: 1, registry: '0xshort', tokenId: 1n })).toThrow(RangeError);
    expect(() => formatErc8004Id({ chainId: 1, registry: REGISTRY, tokenId: -1n })).toThrow(RangeError);
    // Plain-JS caller: 1.5 < 0n is legal JS (false) — the typeof guard must catch it.
    expect(() =>
      formatErc8004Id({ chainId: 1, registry: REGISTRY, tokenId: 1.5 as unknown as bigint }),
    ).toThrow(RangeError);
  });

  it('leading-zero variants normalize through parse -> format', () => {
    const padded = parseErc8004Id(`eip155:84532:${REGISTRY}/007`);
    expect(padded?.tokenId).toBe(7n);
    expect(formatErc8004Id(padded!)).toBe(
      'eip155:84532:0x8004a818bfb912233c491871b3d84c89a494bd9e/7',
    );
    expect(parseErc8004Id(`eip155:0084532:${REGISTRY}/1`)?.chainId).toBe(84532);
  });

  it('Erc8004Id schema accepts canonical ids and rejects junk', () => {
    expect(Erc8004Id.safeParse(`eip155:84532:${REGISTRY}/42`).success).toBe(true);
    expect(Erc8004Id.safeParse('agt_01JBOGUS').success).toBe(false);
  });
});
