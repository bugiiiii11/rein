import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { generatePrivateKey } from 'viem/accounts';
import type { Hex } from 'viem';
import { newId, type Decision, type GateReceipt, type PaymentIntent } from '@rein/core';
import { PolicyEngine } from '@rein/policy-engine';
import { SessionSigner, SignerError } from '@rein/signer';
import { createGate, GateError, type Gate, type GateRails } from '@rein/gate';
import type { PGlite } from '@electric-sql/pglite';
import { openDb } from './db.js';
import { PgGateStore } from './gate-stores.js';
import { PgSessionStore } from './signer-stores.js';
import { openReinStore, type ReinStore } from './index.js';

/**
 * Restart suites for the custody tier and the gate: sessions (token hashes,
 * spend accounting, revocations), burned vouchers, gate receipts, counters,
 * and replay slots all live on @rein/store — kill the process between any two
 * operations and the resumed working set must behave byte-for-byte like the
 * one that died.
 */

const VENDOR_ADDRESS = '0x1111111111111111111111111111111111111111';
const VENDOR_HOST = 'api.vendor.test';
/** Any hex contract works — the signer maps it to USDC via assetAddresses. */
const ASSET = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const TREASURY = '0x7e57000000000000000000000000000000000001';

const dirs: string[] = [];
const opened: ReinStore[] = [];
const dbs: PGlite[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rein-signer-gate-store-'));
  dirs.push(dir);
  return dir;
}

/** Track every store so afterEach can close stragglers (double-close is fine). */
async function open(dir?: string): Promise<ReinStore> {
  const store = await openReinStore(dir ? { dir } : {});
  opened.push(store);
  return store;
}

afterEach(async () => {
  while (opened.length) await opened.pop()!.close().catch(() => undefined);
  while (dbs.length) await dbs.pop()!.close().catch(() => undefined);
});

/** A raw db whose FIRST statement matching `pattern` rejects — the write
 *  failure the rollback paths must survive. */
async function flakyDb(pattern: RegExp): Promise<PGlite> {
  const db = await openDb();
  dbs.push(db);
  let failed = false;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'query') {
        return (sql: string, params?: unknown[]) => {
          if (!failed && pattern.test(sql)) {
            failed = true;
            return Promise.reject(new Error('disk hiccup'));
          }
          return target.query(sql, params);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PGlite;
}

// Data dirs are removed once at the END of the suite: PGlite's emscripten FS
// can flush a moment after close() resolves, and deleting the dir under a
// straggler surfaces as an unhandled ENOENT pinned on the next test.
afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // best-effort: stray temp dirs are harmless
    }
  }
});

// ── signer side ─────────────────────────────────────────────────────────────

/** Engine + signer riding ONE store: vouchers verify across restarts because
 *  the engine key is durable too. The wallet key is re-registered per boot —
 *  custody keys are deliberately not persisted. */
async function makeSignerWorld(store: ReinStore, privateKey: Hex, agentId?: string) {
  const engine = new PolicyEngine(store);
  let id = agentId;
  if (!id) {
    const agent = await engine.registerAgent({
      id: newId('agt'),
      orgId: newId('org'),
      name: 'custody-agent',
      wallets: [],
      status: 'active',
      createdAt: new Date(),
    });
    await engine.addPolicy({
      policyId: 'pol_store_test',
      appliesTo: {},
      rules: [{ id: 'hard-cap', deny: { amountGt: '1.00' } }],
      default: 'allow',
    });
    id = agent.id;
  }
  const signer = new SessionSigner({
    enginePublicKeyPem: engine.publicKeyPem,
    assetAddresses: { [ASSET]: 'USDC' },
    store: store.sessions,
  });
  signer.registerWallet(id, privateKey);
  return { engine, signer, agentId: id };
}

function makeRequirement() {
  return {
    scheme: 'exact',
    network: 'base-sepolia',
    maxAmountRequired: '10000', // 0.01 USDC at 6 decimals
    resource: `https://${VENDOR_HOST}/v1/answer`,
    description: 'an answer',
    mimeType: 'application/json',
    payTo: VENDOR_ADDRESS,
    maxTimeoutSeconds: 300,
    asset: ASSET,
  };
}

function voucherFor(
  engine: PolicyEngine,
  agentId: string,
): Promise<{ intent: PaymentIntent; decision: Decision }> {
  return engine.evaluateIntent({
    agentId,
    vendor: { host: VENDOR_HOST, address: VENDOR_ADDRESS },
    resource: '/v1/answer',
    amount: '0.01',
    asset: 'USDC',
    chain: 'base',
  });
}

async function expectRefusal(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(SignerError);
    expect((err as SignerError).code).toBe(code);
    return;
  }
  throw new Error(`expected a ${code} refusal, but the signer signed`);
}

describe('PgSessionStore across restarts', () => {
  it('resumes a session by its original token: spend continues, cap still bites', async () => {
    const dir = tempDir();
    const key = generatePrivateKey();

    const first = await open(dir);
    const w1 = await makeSignerWorld(first, key);
    const { token, session } = await w1.signer.createSession({
      agentId: w1.agentId,
      capAmount: '0.02',
      ttlSeconds: 24 * 3600,
    });
    const v1 = await voucherFor(w1.engine, w1.agentId);
    await w1.signer.sign({ sessionToken: token, requirement: makeRequirement(), ...v1 });
    expect(w1.signer.sessionSpent(session.id)).toBe('0.01');
    await first.close();

    // The agent process kept its token; only the SIGNER restarted.
    const second = await open(dir);
    expect(second.resumedSessions).toBe(1);
    const w2 = await makeSignerWorld(second, key, w1.agentId);
    expect(w2.signer.sessionSpent(session.id)).toBe('0.01'); // spend resumed
    const v2 = await voucherFor(w2.engine, w2.agentId);
    await w2.signer.sign({ sessionToken: token, requirement: makeRequirement(), ...v2 });
    expect(w2.signer.sessionSpent(session.id)).toBe('0.02');

    // The cap counts PRE-restart spend: a third 0.01 does not fit 0.02.
    const v3 = await voucherFor(w2.engine, w2.agentId);
    await expectRefusal(
      w2.signer.sign({ sessionToken: token, requirement: makeRequirement(), ...v3 }),
      'session_cap_exceeded',
    );
  });

  it('a revocation survives the restart — the kill stays killed', async () => {
    const dir = tempDir();
    const key = generatePrivateKey();

    const first = await open(dir);
    const w1 = await makeSignerWorld(first, key);
    const { token, session } = await w1.signer.createSession({ agentId: w1.agentId });
    await w1.signer.revokeSession(session.id);
    await first.close();

    const second = await open(dir);
    const w2 = await makeSignerWorld(second, key, w1.agentId);
    expect(w2.signer.sessions()[0]?.revokedAt).toBeInstanceOf(Date);
    const v = await voucherFor(w2.engine, w2.agentId);
    await expectRefusal(
      w2.signer.sign({ sessionToken: token, requirement: makeRequirement(), ...v }),
      'session_revoked',
    );
  });

  it('a burned voucher stays burned across the restart', async () => {
    const dir = tempDir();
    const key = generatePrivateKey();

    const first = await open(dir);
    const w1 = await makeSignerWorld(first, key);
    const { token } = await w1.signer.createSession({ agentId: w1.agentId });
    const voucher = await voucherFor(w1.engine, w1.agentId);
    await w1.signer.sign({ sessionToken: token, requirement: makeRequirement(), ...voucher });
    await first.close();

    // Replay the SAME voucher at the restarted signer — within the staleness
    // window, so only the durable burn stands between it and a second signature.
    const second = await open(dir);
    const w2 = await makeSignerWorld(second, key, w1.agentId);
    await expectRefusal(
      w2.signer.sign({ sessionToken: token, requirement: makeRequirement(), ...voucher }),
      'decision_replayed',
    );
  });

  it('works in-memory when no dir is given', async () => {
    const store = await open();
    const w = await makeSignerWorld(store, generatePrivateKey());
    const { token, session } = await w.signer.createSession({ agentId: w.agentId });
    const v = await voucherFor(w.engine, w.agentId);
    await w.signer.sign({ sessionToken: token, requirement: makeRequirement(), ...v });
    expect(w.signer.sessionSpent(session.id)).toBe('0.01');
  });

  it('a failed durable write rejects at the call site (persist-then-cache)', async () => {
    const dir = tempDir();
    const store = await open(dir);
    const w = await makeSignerWorld(store, generatePrivateKey());
    await store.close();
    // The db handle is gone: the awaited INSERT must reject, and the working
    // set must NOT show a session the disk never accepted.
    await expect(w.signer.createSession({ agentId: w.agentId })).rejects.toThrow();
    expect(w.signer.sessions()).toHaveLength(0);
  });

  it('a failed burn write rolls the reservation back — the voucher stays usable', async () => {
    const store = await PgSessionStore.open(
      await flakyDb(/^INSERT INTO signer_used_decisions/),
    );
    // The first burn fails on disk: memory must not claim a burn the disk
    // doesn't hold, or the voucher would die on a transient hiccup.
    await expect(store.burnDecision('dec_flaky')).rejects.toThrow('disk hiccup');
    expect(store.isDecisionUsed('dec_flaky')).toBe(false);
    // Retry succeeds and the burn is real: a second burn refuses.
    await expect(store.burnDecision('dec_flaky')).resolves.toBe(true);
    await expect(store.burnDecision('dec_flaky')).resolves.toBe(false);
  });
});

// ── gate side ───────────────────────────────────────────────────────────────

/** Rails that settle everything and count their calls — replay refusals must
 *  happen BEFORE any rails leg runs. */
function stubRails(): GateRails & { verifies: number; settles: number } {
  const rails = {
    verifies: 0,
    settles: 0,
    async verify() {
      rails.verifies += 1;
    },
    async settle(_header: string, requirement: { network: string }) {
      rails.settles += 1;
      return {
        header: 'settled',
        transaction: `0xt${rails.settles}`,
        network: requirement.network,
        payer: 'stub',
      };
    },
  };
  return rails;
}

function makeGate(store: ReinStore, rails: GateRails): Gate {
  return createGate({
    routes: [{ path: '/v1/query', price: '0.01', description: 'one query' }],
    rails,
    payTo: TREASURY,
    network: 'base',
    asset: 'USDC',
    store: store.gate,
  });
}

/** A flat mock X-PAYMENT header, unique per payer/value pair. */
function payment(from: string, value = '10000'): string {
  return Buffer.from(
    JSON.stringify({
      x402Version: 1,
      scheme: 'exact',
      network: 'base',
      payload: { from, to: TREASURY, value, asset: 'USDC' },
    }),
  ).toString('base64');
}

const QUERY_URL = 'https://api.vendor.test/v1/query';

describe('PgGateStore across restarts', () => {
  it('receipts, revenue stats, and counters resume byte-identically', async () => {
    const dir = tempDir();

    const first = await open(dir);
    const rails1 = stubRails();
    const gate1 = makeGate(first, rails1);
    await gate1.handle({ method: 'GET', url: QUERY_URL, payment: null }); // quote
    const paid = await gate1.handle({ method: 'GET', url: QUERY_URL, payment: payment('0xaaa1') });
    expect(paid.kind).toBe('paid');
    await gate1.handle({ method: 'GET', url: QUERY_URL, payment: payment('0xaaa2') });
    const short = await gate1.handle({
      method: 'GET',
      url: QUERY_URL,
      payment: payment('0xaaa3', '9999'), // underpays -> refused, counted
    });
    expect(short.kind).toBe('refused');
    const statsBefore = gate1.stats();
    const receiptsBefore = gate1.receipts;
    expect(statsBefore).toMatchObject({ quoted: 1, settled: 2, refused: 1 });
    await first.close();

    const second = await open(dir);
    expect(second.resumedReceipts).toBe(2);
    const gate2 = makeGate(second, stubRails());
    expect(gate2.stats()).toEqual(statsBefore);
    expect(gate2.receipts).toEqual(receiptsBefore);
  });

  it('a settled payment cannot re-settle after a restart — the slot is durably burned', async () => {
    const dir = tempDir();
    const header = payment('0xbbb1');

    const first = await open(dir);
    const gate1 = makeGate(first, stubRails());
    const paid = await gate1.handle({ method: 'GET', url: QUERY_URL, payment: header });
    expect(paid.kind).toBe('paid');
    await first.close();

    const second = await open(dir);
    const rails2 = stubRails();
    const gate2 = makeGate(second, rails2);
    const replay = await gate2.handle({ method: 'GET', url: QUERY_URL, payment: header });
    expect(replay).toMatchObject({ kind: 'refused', code: 'payment_replayed' });
    // Refused at the slot — the rails never saw the replay.
    expect(rails2.verifies).toBe(0);
    expect(rails2.settles).toBe(0);
  });

  it('rails_unavailable releases the slot DURABLY — the same header settles after a restart', async () => {
    const dir = tempDir();
    const header = payment('0xrel1');

    const first = await open(dir);
    const downGate = createGate({
      routes: [{ path: '/v1/query', price: '0.01' }],
      rails: {
        async verify() {
          throw new TypeError('rails unreachable');
        },
        async settle() {
          throw new TypeError('rails unreachable');
        },
      },
      retry: { attempts: 0, backoffMs: 0 },
      payTo: TREASURY,
      network: 'base',
      asset: 'USDC',
      store: first.gate,
    });
    const outcome = await downGate.handle({ method: 'GET', url: QUERY_URL, payment: header });
    expect(outcome).toMatchObject({ kind: 'refused', code: 'rails_unavailable' });
    await first.close();

    // The release hit disk: after a restart the header is fresh, not replayed.
    const second = await open(dir);
    const rails2 = stubRails();
    const gate2 = makeGate(second, rails2);
    const retried = await gate2.handle({ method: 'GET', url: QUERY_URL, payment: header });
    expect(retried.kind).toBe('paid');
    expect(rails2.settles).toBe(1);
  });

  it('velocity caps ride the hydrated receipts — pre-restart spend still counts', async () => {
    const dir = tempDir();
    const t0 = Date.now();
    let t = t0;
    // Caps are PER PAYER: one payer, distinct headers (uniquified off-schema).
    const velPayment = (id: string) =>
      Buffer.from(
        JSON.stringify({
          x402Version: 1,
          scheme: 'exact',
          network: 'base',
          payload: { from: '0xvel1', to: TREASURY, value: '10000', asset: 'USDC', intentId: id },
        }),
      ).toString('base64');
    const velocityGate = (store: ReinStore, rails: GateRails) =>
      createGate({
        routes: [{ path: '/v1/query', price: '0.01' }],
        rails,
        velocity: { windowMs: 60_000, maxPayments: 1 },
        now: () => new Date(t),
        payTo: TREASURY,
        network: 'base',
        asset: 'USDC',
        store: store.gate,
      });

    const first = await open(dir);
    const paid = await velocityGate(first, stubRails()).handle({
      method: 'GET',
      url: QUERY_URL,
      payment: velPayment('v1'),
    });
    expect(paid.kind).toBe('paid');
    await first.close();

    const second = await open(dir);
    const gate2 = velocityGate(second, stubRails());
    t = t0 + 1_000; // still inside the window: the RESUMED receipt must bite
    const capped = await gate2.handle({ method: 'GET', url: QUERY_URL, payment: velPayment('v2') });
    expect(capped).toMatchObject({ kind: 'refused', code: 'velocity_exceeded' });

    t = t0 + 60_001; // window slid past the pre-restart receipt
    const cleared = await gate2.handle({ method: 'GET', url: QUERY_URL, payment: velPayment('v2') });
    expect(cleared.kind).toBe('paid');
  });

  it('a failed replay-slot write refuses to settle (escapes as a non-GateError)', async () => {
    const dir = tempDir();
    const store = await open(dir);
    const gate = makeGate(store, stubRails());
    await store.close();
    // With the db gone the burn cannot persist: the gate must fail the request
    // outright (500 path), never settle without durable replay protection.
    await expect(
      gate.handle({ method: 'GET', url: QUERY_URL, payment: payment('0xccc1') }),
    ).rejects.not.toBeInstanceOf(GateError);
  });

  it('close() flushes trailing telemetry — a receipt appended in the same tick survives', async () => {
    const dir = tempDir();
    const first = await open(dir);
    const receipt: GateReceipt = {
      id: newId('grc'),
      at: new Date(),
      route: '/v1/query',
      resource: '/v1/query',
      method: 'GET',
      payer: '0xeee1',
      payTo: TREASURY,
      amount: '0.01',
      amountAtomic: '10000',
      asset: 'USDC',
      network: 'base',
      transaction: '0xflush',
    };
    // No yield between the append and close(): only the shutdown flush stands
    // between this write-behind receipt and the void.
    void first.gate.appendReceipt(receipt);
    await first.close();

    const second = await open(dir);
    expect(second.gate.receipts().map((r) => r.id)).toContain(receipt.id);
  });

  it('a failed replay-slot write rolls the burn back — the slot stays presentable', async () => {
    const store = await PgGateStore.open(await flakyDb(/^INSERT INTO gate_replays/));
    await expect(store.burnReplay('slot_flaky')).rejects.toThrow('disk hiccup');
    // Rolled back: the payment may be re-presented and settle.
    await expect(store.burnReplay('slot_flaky')).resolves.toBe(true);
    await expect(store.burnReplay('slot_flaky')).resolves.toBe(false);
  });

  it('a failed telemetry write surfaces on flush(), then clears', async () => {
    const dir = tempDir();
    const store = await open(dir);
    await store.close();
    // Write-behind: the append itself does not throw at the call site...
    const receipt = {
      id: newId('grc'),
      at: new Date(),
      route: '/v1/query',
      resource: '/v1/query',
      method: 'GET',
      payer: '0xddd1',
      payTo: TREASURY,
      amount: '0.01',
      amountAtomic: '10000',
      asset: 'USDC',
      network: 'base',
      transaction: '0xdead',
    };
    store.gate.appendReceipt(receipt).catch(() => undefined);
    // ...but the tail recorded it, and flush() is the error channel.
    await expect(store.gate.flush()).rejects.toThrow();
    await expect(store.gate.flush()).resolves.toBeUndefined();
  });
});
