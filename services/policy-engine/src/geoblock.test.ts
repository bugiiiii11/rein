import { describe, it, expect } from 'vitest';
import {
  DEFAULT_GEOBLOCK_TERRITORIES,
  GeoBlock,
  addressValue,
  clientAddress,
  geoBlockFromEnv,
  privateAddress,
} from './geoblock.js';
import { GEO_EDITION, GEO_RANGES } from './geo-data.js';
import { buildServer } from './server.js';

/** The first address of a territory's first range, as text. */
function firstV4(territory: string): string {
  const start = parseInt(GEO_RANGES[territory]!.v4.slice(0, 8), 16);
  return [start >>> 24, (start >>> 16) & 255, (start >>> 8) & 255, start & 255].join('.');
}
function firstV6(territory: string): string {
  const hex = GEO_RANGES[territory]!.v6.slice(0, 32);
  return hex.match(/.{4}/g)!.join(':');
}

describe('the geo-block lookup', () => {
  const geo = new GeoBlock();

  it('names the territory of an address in a refused range, v4 and v6', () => {
    expect(geo.territoryOf('175.45.176.1')).toBe('KP');
    expect(geo.territoryOf('5.160.0.1')).toBe('IR');
    expect(geo.territoryOf('152.206.0.1')).toBe('CU');
    expect(geo.territoryOf(firstV4('UA-43'))).toBe('UA-43');
    expect(geo.territoryOf(firstV6('IR'))).toBe('IR');
  });

  it('passes the rest of the world, private ranges and garbage', () => {
    for (const ip of ['8.8.8.8', '1.1.1.1', '2a01:4f8::1', '10.0.0.1', '127.0.0.1', '::1', 'not-an-ip', '']) {
      expect(geo.territoryOf(ip)).toBeUndefined();
    }
    expect(geo.territoryOf(undefined)).toBeUndefined();
  });

  it('sees a v4 client through a dual-stack socket', () => {
    expect(geo.territoryOf('::ffff:175.45.176.9')).toBe('KP');
  });

  it('refuses only the territories it was built with: Syria is generated but not default', () => {
    expect(DEFAULT_GEOBLOCK_TERRITORIES).not.toContain('SY');
    expect(geo.territoryOf(firstV4('SY'))).toBeUndefined();
    expect(new GeoBlock(['SY']).territoryOf(firstV4('SY'))).toBe('SY');
  });

  it('refuses to build with a territory it has no ranges for', () => {
    expect(() => new GeoBlock(['RU'])).toThrow(/no ranges for RU/);
  });

  it('carries the DB-IP edition it was cut from', () => {
    expect(geo.edition).toBe(GEO_EDITION);
    expect(GEO_EDITION).toMatch(/^\d{4}-\d{2}$/);
  });
});

describe('addressValue', () => {
  it('parses v4, compressed v6, an embedded v4 tail and a zone id', () => {
    expect(addressValue('1.2.3.4')).toEqual({ family: 4, value: 0x01020304n });
    expect(addressValue('::1')).toEqual({ family: 6, value: 1n });
    expect(addressValue('2001:db8::1.2.3.4')?.value).toBe(0x20010db8000000000000000001020304n);
    expect(addressValue('fe80::1%eth0')?.value).toBe(0xfe800000000000000000000000000001n);
    expect(addressValue('1.2.3')).toBeUndefined();
  });
});

describe('clientAddress: the client behind a private proxy', () => {
  it('takes the address the proxy appended, whatever the client wrote before it', () => {
    expect(clientAddress('10.0.0.5', '6.6.6.6, 175.45.176.1')).toBe('175.45.176.1');
    expect(clientAddress('10.0.0.5', ['175.45.176.1', '8.8.8.8'])).toBe('8.8.8.8');
  });

  it('never believes the header of a client that connected directly', () => {
    expect(clientAddress('175.45.176.1', '8.8.8.8')).toBe('175.45.176.1');
  });

  it('walks several private hops and stops at the first public one', () => {
    expect(clientAddress('127.0.0.1', '175.45.176.1, 10.1.1.1')).toBe('175.45.176.1');
    expect(clientAddress('127.0.0.1', undefined)).toBe('127.0.0.1');
  });

  it('knows the private ranges', () => {
    for (const ip of ['10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '127.0.0.1', '169.254.1.1', '::1', 'fd12::1', 'fe80::1']) {
      expect(privateAddress(ip)).toBe(true);
    }
    for (const ip of ['172.32.0.1', '8.8.8.8', '2a01::1']) expect(privateAddress(ip)).toBe(false);
  });
});

describe('geoBlockFromEnv', () => {
  it('follows the fallback when unset, and an explicit value over it', () => {
    expect(geoBlockFromEnv({}, false)).toBeUndefined();
    expect(geoBlockFromEnv({}, true)?.territories).toEqual(DEFAULT_GEOBLOCK_TERRITORIES);
    expect(geoBlockFromEnv({ REIN_GEOBLOCK: 'off' }, true)).toBeUndefined();
    expect(geoBlockFromEnv({ REIN_GEOBLOCK: 'on' }, false)?.territories).toEqual(DEFAULT_GEOBLOCK_TERRITORIES);
    expect(geoBlockFromEnv({ REIN_GEOBLOCK: 'ir, kp,ua-43' }, false)?.territories).toEqual(['IR', 'KP', 'UA-43']);
  });

  it('refuses a territory it cannot block rather than booting without it', () => {
    expect(() => geoBlockFromEnv({ REIN_GEOBLOCK: 'IR,XX' }, true)).toThrow(/no ranges for XX/);
  });
});

describe('the engine geo-block', () => {
  it('answers 451 from a refused territory on every route but /health, before auth', async () => {
    const app = buildServer(undefined, { geoBlock: new GeoBlock() });
    const from = (remoteAddress: string, url: string) => app.inject({ method: 'GET', url, remoteAddress });
    const blocked = await from('175.45.176.1', '/v1/agents');
    expect(blocked.statusCode).toBe(451);
    expect(blocked.json()).toEqual({ error: 'restricted_territory', message: 'Rein is not available in your region.' });
    expect((await from('175.45.176.1', '/health')).statusCode).toBe(200);
    expect((await from('8.8.8.8', '/v1/agents')).statusCode).toBe(200);
    await app.close();
  });

  it('judges the client behind a trusted proxy, not the proxy', async () => {
    const app = buildServer(undefined, { geoBlock: new GeoBlock(), trustProxy: 'loopback,linklocal,uniquelocal' });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      remoteAddress: '10.0.0.7',
      headers: { 'x-forwarded-for': '8.8.8.8, 5.160.0.1' },
    });
    expect(res.statusCode).toBe(451);
    await app.close();
  });
});
