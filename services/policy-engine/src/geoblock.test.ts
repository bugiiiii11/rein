import { describe, it, expect } from 'vitest';
import { newId } from '@reinconsole/core';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { SESSION_KEY_PREFIX } from './claims.js';
import {
  DEFAULT_GEOBLOCK_TERRITORIES,
  EEA_TERRITORIES,
  GEOBLOCK_BODY,
  GEOBLOCK_NOT_OFFERED_BODY,
  GeoBlock,
  addressValue,
  clientAddress,
  geoBlockFromEnv,
  geoBlockOperatorOrgsFromEnv,
  onRailway,
  platformProxyAddress,
  privateAddress,
  railwayClientAddress,
} from './geoblock.js';
import { GEO_EDITION, GEO_RANGES } from './geo-data.js';
import { RAILWAY_PROXY, buildServer, parseTrustProxy } from './server.js';

/** The first address of a territory's first range, as text. */
function firstV4(territory: string): string {
  const start = parseInt(GEO_RANGES[territory]!.v4.slice(0, 8), 16);
  return [start >>> 24, (start >>> 16) & 255, (start >>> 8) & 255, start & 255].join('.');
}
function firstV6(territory: string): string {
  // v6 ranges are /64 prefixes: 16 hex chars, the top half of the address.
  const hex = GEO_RANGES[territory]!.v6.slice(0, 16);
  return `${hex.match(/.{4}/g)!.join(':')}::1`;
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

describe('the client address on Railway (measured 2026-11-19)', () => {
  const DE = firstV4('DE');
  const EDGE = '100.64.0.10';
  const world = () => buildServer(undefined, { geoBlock: new GeoBlock([...DEFAULT_GEOBLOCK_TERRITORIES, 'DE']), trustProxy: RAILWAY_PROXY });

  it('resolves `1` to the Railway shape inside a Railway container, and only there', () => {
    expect(parseTrustProxy('1', {})).toBe('loopback,linklocal,uniquelocal');
    expect(parseTrustProxy('1', { RAILWAY_SERVICE_ID: 'svc' })).toBe(RAILWAY_PROXY);
    expect(parseTrustProxy('railway', {})).toBe(RAILWAY_PROXY);
    expect(parseTrustProxy('off', { RAILWAY_SERVICE_ID: 'svc' })).toBe(false);
    expect(onRailway({})).toBe(false);
  });

  it('knows the shared range the edge connects from', () => {
    for (const ip of ['100.64.0.2', '100.127.255.255', '10.0.0.1', '::1']) expect(platformProxyAddress(ip), ip).toBe(true);
    for (const ip of ['100.63.255.255', '100.128.0.0', '152.233.12.241', undefined]) expect(platformProxyAddress(ip)).toBe(false);
  });

  it('judges X-Real-IP from the edge: the exact headers the live engine received', async () => {
    const app = world();
    const from = (realIp: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/agents',
        remoteAddress: EDGE,
        headers: { 'x-real-ip': realIp, 'x-forwarded-for': `${realIp}, 152.233.12.241` },
      });
    expect((await from(DE)).statusCode).toBe(451);
    expect((await from('8.8.8.8')).statusCode).toBe(200);
    await app.close();
  });

  it('never believes a client that connects directly, whatever it wrote', async () => {
    const app = world();
    const direct = (remoteAddress: string, headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/v1/agents', remoteAddress, headers });
    // From DE, claiming to be elsewhere.
    expect((await direct(DE, { 'x-real-ip': '8.8.8.8', 'x-forwarded-for': '8.8.8.8' })).statusCode).toBe(451);
    // From elsewhere, naming DE: not refused for it.
    expect((await direct('8.8.8.8', { 'x-real-ip': DE, 'x-forwarded-for': DE })).statusCode).toBe(200);
    await app.close();
  });

  it('falls back to the proxy address when the edge names nobody, and ignores X-Forwarded-For', async () => {
    const app = world();
    const res = await app.inject({ method: 'GET', url: '/v1/agents', remoteAddress: EDGE, headers: { 'x-forwarded-for': DE } });
    expect(res.statusCode).toBe(200);
    const junk = await app.inject({ method: 'GET', url: '/v1/agents', remoteAddress: EDGE, headers: { 'x-real-ip': 'not-an-ip' } });
    expect(junk.statusCode).toBe(200);
    await app.close();
  });

  it('is the same rule for the console', () => {
    expect(railwayClientAddress(EDGE, DE)).toBe(DE);
    expect(railwayClientAddress(EDGE, [DE, '8.8.8.8'])).toBe(DE);
    expect(railwayClientAddress(DE, '8.8.8.8')).toBe(DE);
    expect(railwayClientAddress(EDGE, undefined)).toBe(EDGE);
    expect(railwayClientAddress(EDGE, 'junk')).toBe(EDGE);
  });
});

describe('the EEA and the operator bypass (2026-11-18)', () => {
  const DE = firstV4('DE');
  const KP = '175.45.176.1';

  it('expands `default` and `EEA` inside REIN_GEOBLOCK, with ranges for all thirty states', () => {
    expect(EEA_TERRITORIES).toHaveLength(30);
    const hosted = geoBlockFromEnv({ REIN_GEOBLOCK: 'default,GB,EEA' }, false)!;
    expect(hosted.territories).toEqual([...DEFAULT_GEOBLOCK_TERRITORIES, 'GB', ...EEA_TERRITORIES]);
    for (const code of [...EEA_TERRITORIES, 'GB']) {
      expect(hosted.territoryOf(firstV4(code)), code).toBe(code);
      expect(hosted.territoryOf(firstV6(code)), code).toBe(code);
    }
    expect(hosted.territoryOf('8.8.8.8')).toBeUndefined();
    // Not in the default set: a self-hoster refuses none of it.
    expect(new GeoBlock().territoryOf(DE)).toBeUndefined();
  });

  it('reads REIN_GEOBLOCK_OPERATOR_ORGS: unset = no bypass, `none` = an empty list', () => {
    expect(geoBlockOperatorOrgsFromEnv({})).toBeUndefined();
    expect(geoBlockOperatorOrgsFromEnv({ REIN_GEOBLOCK_OPERATOR_ORGS: 'none' })).toEqual([]);
    expect(geoBlockOperatorOrgsFromEnv({ REIN_GEOBLOCK_OPERATOR_ORGS: ' org_a, org_b ' })).toEqual(['org_a', 'org_b']);
  });

  it('tells a not-offered territory where to self-host, and a sanctioned one nothing', async () => {
    const app = buildServer(undefined, { geoBlock: new GeoBlock([...DEFAULT_GEOBLOCK_TERRITORIES, 'DE']) });
    const de = await app.inject({ method: 'GET', url: '/v1/agents', remoteAddress: DE });
    expect(de.statusCode).toBe(451);
    expect(de.json()).toEqual(GEOBLOCK_NOT_OFFERED_BODY);
    expect(de.json().message).toContain('https://reinconsole.com/run-rein-locally');
    const kp = await app.inject({ method: 'GET', url: '/v1/agents', remoteAddress: KP });
    expect(kp.json()).toEqual(GEOBLOCK_BODY);
    await app.close();
  });

  async function hosted(bypass: boolean) {
    const auth = new ApiKeyAuth();
    const operatorOrg = newId('org');
    const strangerOrg = newId('org');
    const keys = {
      unscoped: await auth.issue({ name: 'console-read', scopes: ['read'] }),
      operator: await auth.issue({ name: 'matt', scopes: ['read'], orgId: operatorOrg }),
      stranger: await auth.issue({ name: 'someone', scopes: ['read'], orgId: strangerOrg }),
      session: await auth.issue({ name: `${SESSION_KEY_PREFIX}github:1`, scopes: ['read'], orgId: strangerOrg }),
      evaluateOnly: await auth.issue({ name: 'matt-runtime', scopes: ['evaluate'], orgId: operatorOrg }),
    };
    const app = buildServer(undefined, {
      auth,
      geoBlock: new GeoBlock([...DEFAULT_GEOBLOCK_TERRITORIES, 'DE']),
      ...(bypass ? { geoBlockOperatorOrgs: [operatorOrg] } : {}),
    });
    const get = (remoteAddress: string, secret?: string) =>
      app.inject({
        method: 'GET',
        url: '/v1/agents',
        remoteAddress,
        headers: secret ? { authorization: `Bearer ${secret}` } : {},
      });
    return { app, keys, get };
  }

  it('lets the operator team through from a not-offered territory, by key and org only', async () => {
    const { app, keys, get } = await hosted(true);
    expect((await get(DE, keys.unscoped.secret)).statusCode).toBe(200);
    expect((await get(DE, keys.operator.secret)).statusCode).toBe(200);
    expect((await get(DE, keys.session.secret)).statusCode).toBe(200);
    // Everyone else gets the same 451 as a caller with no key: not a 401, not a 403.
    for (const secret of [undefined, 'rk_not_a_key', keys.stranger.secret]) {
      const res = await get(DE, secret);
      expect(res.statusCode).toBe(451);
      expect(res.json()).toEqual(GEOBLOCK_NOT_OFFERED_BODY);
    }
    // A key that could not make this call anyway does not pass on its org alone.
    expect((await get(DE, keys.evaluateOnly.secret)).statusCode).toBe(451);
    await app.close();
  });

  it('tells a key who it is on /v1/whoami, and nothing about anyone else', async () => {
    const { app, keys } = await hosted(true);
    const who = async (secret: string) =>
      (await app.inject({ method: 'GET', url: '/v1/whoami', remoteAddress: '8.8.8.8', headers: { authorization: `Bearer ${secret}` } })).json();
    const operator = await who(keys.operator.secret);
    expect(operator).toEqual({
      auth: 'api-key',
      keyId: keys.operator.key.id,
      name: 'matt',
      scopes: ['read'],
      orgId: keys.operator.key.orgId,
    });
    const root = await who(keys.unscoped.secret);
    expect(root.orgId).toBeUndefined();
    expect(root.name).toBe('console-read');
    const none = await app.inject({ method: 'GET', url: '/v1/whoami', remoteAddress: '8.8.8.8' });
    expect(none.statusCode).toBe(401);
    await app.close();
  });

  it('never bypasses a sanctioned territory, whatever the key', async () => {
    const { app, keys, get } = await hosted(true);
    for (const secret of [keys.unscoped.secret, keys.operator.secret, keys.session.secret]) {
      const res = await get(KP, secret);
      expect(res.statusCode).toBe(451);
      expect(res.json()).toEqual(GEOBLOCK_BODY);
    }
    await app.close();
  });

  it('has no bypass at all unless the option is given', async () => {
    const { app, keys, get } = await hosted(false);
    for (const secret of [keys.unscoped.secret, keys.operator.secret, keys.session.secret]) {
      expect((await get(DE, secret)).statusCode).toBe(451);
    }
    expect((await get('8.8.8.8', keys.stranger.secret)).statusCode).toBe(200);
    await app.close();
  });
});
