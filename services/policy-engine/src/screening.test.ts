import { describe, it, expect, vi } from 'vitest';
import { ApiKeyAuth } from '@reinconsole/core/auth';
import { buildServer, MAINNET_SCREENED } from './server.js';
import { PolicyEngine } from './engine.js';
import {
  CHAINALYSIS_ORACLE,
  ScreeningError,
  ScreeningService,
  chainalysisOracle,
  ownerWallet,
  screenerFromEnv,
  type SanctionsScreener,
} from './screening.js';

const CLEAN = '0x1111111111111111111111111111111111111111';
const LISTED = '0x098b716b8aaf21512996dc57eb0615e2383e2f96';
const WORD = (bit: 0 | 1) => `0x${'0'.repeat(63)}${bit}`;

/** A screener over a fixed list; `down` makes it throw like a dead RPC. */
function fakeScreener(listed: readonly string[] = [LISTED]) {
  const state = { down: false, calls: [] as string[] };
  const screener: SanctionsScreener = {
    describe: 'fake',
    async screen(address) {
      state.calls.push(address);
      if (state.down) throw new Error('no RPC answered');
      return { sanctioned: listed.includes(address.toLowerCase()), source: 'fake' };
    },
  };
  return { screener, state };
}

function rpc(answers: Array<Response | Error>) {
  const calls: Array<{ url: string; body: { params: [{ to: string; data: string }, string] } }> = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
    const next = answers.shift();
    if (!next || next instanceof Error) throw next ?? new Error('unexpected call');
    return next;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('the Chainalysis oracle screener', () => {
  it('calls isSanctioned(address) on the oracle and reads the bool', async () => {
    const { fetchImpl, calls } = rpc([json({ jsonrpc: '2.0', id: 1, result: WORD(1) })]);
    const oracle = chainalysisOracle({ rpcUrls: ['https://rpc.one'], fetch: fetchImpl });
    expect(await oracle.screen(LISTED)).toEqual({ sanctioned: true, source: 'chainalysis-oracle@rpc.one' });
    const [{ to, data }, block] = calls[0]!.body.params;
    expect(to).toBe(CHAINALYSIS_ORACLE);
    expect(data).toBe(`0xdf592f7d000000000000000000000000${LISTED.slice(2)}`);
    expect(block).toBe('latest');
  });

  it('falls through to the next RPC when one fails or answers nonsense', async () => {
    const { fetchImpl } = rpc([
      new Error('ECONNRESET'),
      json({ jsonrpc: '2.0', id: 1, error: { message: 'rate limited' } }, 429),
      json({ jsonrpc: '2.0', id: 1, result: '0x' }),
      json({ jsonrpc: '2.0', id: 1, result: WORD(0) }),
    ]);
    const oracle = chainalysisOracle({
      rpcUrls: ['https://a.example', 'https://b.example', 'https://c.example', 'https://d.example'],
      fetch: fetchImpl,
    });
    expect(await oracle.screen(CLEAN)).toEqual({ sanctioned: false, source: 'chainalysis-oracle@d.example' });
  });

  it('throws when no RPC answers -- it never guesses clear', async () => {
    const { fetchImpl } = rpc([new Error('down'), json({}, 500)]);
    const oracle = chainalysisOracle({ rpcUrls: ['https://a.example', 'https://b.example'], fetch: fetchImpl });
    await expect(oracle.screen(CLEAN)).rejects.toThrow(/no RPC answered: a.example: down; b.example: 500/);
  });
});

describe('ScreeningService', () => {
  it('records every address, deduplicated, and returns when all are clear', async () => {
    const { screener } = fakeScreener();
    const service = new ScreeningService(screener);
    const records = await service.check('org_x', 'claim', [
      { address: CLEAN, role: 'owner' },
      { address: CLEAN.toUpperCase().replace('0X', '0x'), role: 'agent', agentId: 'agt_1' },
      { address: 'not-an-address', role: 'agent' },
    ]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ orgId: 'org_x', trigger: 'claim', address: CLEAN, role: 'owner', result: 'clear' });
    expect(service.list()).toHaveLength(1);
  });

  it('refuses on a hit with a plain 403, keeps the record, and says so in the log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const service = new ScreeningService(fakeScreener().screener);
    const err = await service
      .check('org_x', 'mainnet', [{ address: LISTED, role: 'agent', agentId: 'agt_1' }])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScreeningError);
    expect(err).toMatchObject({ status: 403, code: 'screening_refused' });
    expect((err as Error).message).not.toMatch(/sanction|OFAC|list/i);
    expect(service.list()[0]).toMatchObject({ result: 'sanctioned', agentId: 'agt_1' });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('SANCTIONS HIT at mainnet for org org_x'));
    warn.mockRestore();
  });

  it('fails closed with a 503 when the check cannot run, and records that too', async () => {
    const { screener, state } = fakeScreener();
    state.down = true;
    const service = new ScreeningService(screener);
    await expect(service.check('org_x', 'claim', [{ address: CLEAN, role: 'owner' }])).rejects.toMatchObject({
      status: 503,
      code: 'screening_unavailable',
    });
    expect(service.list()[0]).toMatchObject({ result: 'unavailable', detail: 'no RPC answered' });
  });

  it('lists newest first, per org', async () => {
    const service = new ScreeningService(fakeScreener().screener);
    await service.check('org_a', 'claim', [{ address: CLEAN, role: 'owner' }]);
    await service.check('org_b', 'claim', [{ address: CLEAN, role: 'owner' }]);
    expect(service.list().map((r) => r.orgId)).toEqual(['org_b', 'org_a']);
    expect(service.list({ orgId: 'org_a' })).toHaveLength(1);
  });
});

describe('env and helpers', () => {
  it('ownerWallet reads an Ethereum identity and nothing else', () => {
    expect(ownerWallet(`eth:${CLEAN}`)).toBe(CLEAN);
    expect(ownerWallet('github:42')).toBeUndefined();
    expect(ownerWallet(undefined)).toBeUndefined();
  });

  it('screenerFromEnv follows the fallback, honours off, and refuses nonsense', () => {
    expect(screenerFromEnv({}, false)).toBeUndefined();
    expect(screenerFromEnv({}, true)?.describe).toMatch(/ethereum-rpc\.publicnode\.com/);
    expect(screenerFromEnv({ REIN_SANCTIONS_SCREENING: 'off' }, true)).toBeUndefined();
    expect(screenerFromEnv({ REIN_SANCTIONS_SCREENING: 'on', REIN_SANCTIONS_RPC_URLS: 'https://my.rpc' }, false)?.describe).toMatch(
      /via my\.rpc$/,
    );
    expect(() => screenerFromEnv({ REIN_SANCTIONS_SCREENING: 'maybe' }, true)).toThrow();
    expect(() => screenerFromEnv({ REIN_SANCTIONS_RPC_URLS: 'http://plain' }, true)).toThrow(/not an https URL/);
  });
});

/** The hosted shape: sandbox + claims + screening, with a fake screener. */
async function hosted(options: { mainnetOrgs?: readonly string[]; listed?: readonly string[] } = {}) {
  const auth = new ApiKeyAuth();
  const engine = new PolicyEngine();
  const { screener, state } = fakeScreener(options.listed);
  const screening = new ScreeningService(screener);
  const app = buildServer(engine, {
    auth,
    sandbox: {},
    screening,
    ...(options.mainnetOrgs ? { mainnetOrgs: options.mainnetOrgs } : {}),
  });
  const consoleKey = (await auth.issue({ name: 'console-identity', scopes: ['identity'] })).secret;
  const root = (await auth.issue({ name: 'root', scopes: ['admin', 'read'] })).secret;
  const bearer = (secret: string) => ({ authorization: `Bearer ${secret}` });
  const sandbox = async (wallet = CLEAN) =>
    (await app.inject({ method: 'POST', url: '/v1/sandbox', payload: { wallet } })).json() as {
      orgId: string;
      agentId: string;
      apiKey: string;
    };
  const code = async (key: string) =>
    (await app.inject({ method: 'POST', url: '/v1/claims', headers: bearer(key) })).json().code as string;
  const redeem = (c: string, identity: string) =>
    app.inject({ method: 'POST', url: '/v1/claims/redeem', headers: bearer(consoleKey), payload: { code: c, identity } });
  const mainnet = (key: string, agentId: string) =>
    app.inject({
      method: 'POST',
      url: '/v1/keys',
      headers: bearer(key),
      payload: { name: 'mainnet-runtime', scopes: ['evaluate', 'read'], agentIds: [agentId], mainnet: true },
    });
  return { app, screening, state, root, bearer, sandbox, code, redeem, mainnet };
}

describe('screening at claim', () => {
  it('screens the Ethereum owner and the agent wallet, then binds', async () => {
    const { app, screening, sandbox, code, redeem } = await hosted();
    const sb = await sandbox();
    const owner = '0x2222222222222222222222222222222222222222';
    const res = await redeem(await code(sb.apiKey), `eth:${owner}`);
    expect(res.statusCode).toBe(200);
    expect(screening.list().map((r) => [r.trigger, r.role, r.address])).toEqual(
      expect.arrayContaining([
        ['claim', 'owner', owner],
        ['claim', 'agent', CLEAN],
      ]),
    );
    await app.close();
  });

  it('refuses a listed owner and spends the code', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app, sandbox, code, redeem } = await hosted();
    const sb = await sandbox();
    const c = await code(sb.apiKey);
    const refused = await redeem(c, `eth:${LISTED}`);
    expect(refused.statusCode).toBe(403);
    expect(refused.json().error).toBe('screening_refused');
    expect((await redeem(c, 'github:7')).json().error).toBe('unknown_claim_code');
    warn.mockRestore();
    await app.close();
  });

  it('refuses a GitHub owner whose agent wallet is listed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { app, sandbox, code, redeem } = await hosted();
    const sb = await sandbox(LISTED);
    expect((await redeem(await code(sb.apiKey), 'github:7')).statusCode).toBe(403);
    warn.mockRestore();
    await app.close();
  });

  it('answers 503 when the check cannot run, and the same code works once it can', async () => {
    const { app, state, sandbox, code, redeem } = await hosted();
    const sb = await sandbox();
    const c = await code(sb.apiKey);
    state.down = true;
    const down = await redeem(c, 'github:7');
    expect(down.statusCode).toBe(503);
    expect(down.headers['retry-after']).toBe('60');
    state.down = false;
    expect((await redeem(c, 'github:7')).statusCode).toBe(200);
    await app.close();
  });
});

describe('screening at mainnet', () => {
  it(`"${MAINNET_SCREENED}" admits a claimed org that passes, and only a claimed one`, async () => {
    const { app, sandbox, code, redeem, mainnet } = await hosted({ mainnetOrgs: [MAINNET_SCREENED] });
    const sb = await sandbox();
    const unclaimed = await mainnet(sb.apiKey, sb.agentId);
    expect(unclaimed.statusCode).toBe(403);
    expect(unclaimed.json()).toMatchObject({ error: 'mainnet_not_enabled' });
    expect(unclaimed.json().message).toMatch(/needs a claimed org/);

    await redeem(await code(sb.apiKey), 'github:7');
    expect((await mainnet(sb.apiKey, sb.agentId)).statusCode).toBe(201);
    await app.close();
  });

  it('refuses a listed wallet even for an org on the allow-list, and records the mainnet check', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const listed = [LISTED];
    // The allow-list is read per request, so the org can join it once it exists.
    const allowList: string[] = [];
    const { app, screening, sandbox, code, redeem, mainnet } = await hosted({ mainnetOrgs: allowList, listed });
    const sb = await sandbox();
    allowList.push(sb.orgId);
    await redeem(await code(sb.apiKey), 'github:7');
    // Listed AFTER the claim: the mainnet check is a second, independent look.
    listed.push(CLEAN);
    const res = await mainnet(sb.apiKey, sb.agentId);
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('screening_refused');
    expect(screening.list()[0]).toMatchObject({ trigger: 'mainnet', result: 'sanctioned' });
    warn.mockRestore();
    await app.close();
  });

  it('still refuses an unlisted org on the default hosted gate, without screening it', async () => {
    const { app, state, sandbox, code, redeem, mainnet } = await hosted();
    const sb = await sandbox();
    await redeem(await code(sb.apiKey), 'github:7');
    state.calls.length = 0;
    const res = await mainnet(sb.apiKey, sb.agentId);
    expect(res.json().error).toBe('mainnet_not_enabled');
    expect(state.calls).toEqual([]);
    await app.close();
  });

  it(`refuses to build "${MAINNET_SCREENED}" without screening`, () => {
    expect(() => buildServer(undefined, { auth: new ApiKeyAuth(), sandbox: {}, mainnetOrgs: [MAINNET_SCREENED] })).toThrow(
      /needs screening/,
    );
  });
});

describe('GET /v1/screenings', () => {
  it('shows the operator every check, and no tenant any', async () => {
    const { app, root, bearer, sandbox, code, redeem } = await hosted();
    const sb = await sandbox();
    await redeem(await code(sb.apiKey), 'github:7');
    const all = await app.inject({ method: 'GET', url: `/v1/screenings?orgId=${sb.orgId}`, headers: bearer(root) });
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual([expect.objectContaining({ orgId: sb.orgId, address: CLEAN, result: 'clear' })]);
    const tenant = await app.inject({ method: 'GET', url: '/v1/screenings', headers: bearer(sb.apiKey) });
    expect(tenant.statusCode).toBe(403);
    expect(tenant.json().error).toBe('route_not_scopable');
    await app.close();
  });
});
