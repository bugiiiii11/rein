/**
 * The PERSISTENT console world: `REIN_CONSOLE_DATA_DIR` (WorldOptions.dataDir)
 * puts the engine, graph, gate and signer on @reinconsole/store, so a restart
 * resumes the story instead of retelling it. These tests boot the same data
 * directory three times and pin what must survive, what must NOT, and what must
 * change on purpose:
 *
 *   - state survives (decisions, settlements, receipts, reputation subjects);
 *   - the boot seed and the 15-beat scenario run ONLY on a fresh store, so a
 *     resume never double-counts;
 *   - the feed does not survive — it is this process's telemetry, not state;
 *   - session-tier keys ROTATE every boot (custody keys are deliberately never
 *     persisted) while SDK-tier wallets stay put, and identity linking keeps one
 *     reputation across the rotation rather than minting a stray scoreboard row;
 *   - dead grants are revoked AND dropped, so grants do not accrete one per boot
 *     (the S28 finding) — proven across TWO rotations, not one.
 *
 * Boots are sequential and each world is closed before the next opens: one
 * PGlite data directory admits a single writer.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorld } from './world';
import type { AgentView, ConsoleState } from './wire';

let dir: string;
/** Snapshot per boot: 1 = fresh (seeded + scenario), 2 and 3 = resumed. */
let first: ConsoleState;
let resumed: ConsoleState;
let afterPing: ConsoleState;
let third: ConsoleState;
/** Did the resumed session-tier agent's guarded call actually reach the engine? */
let pingOk = false;

const SESSION_AGENT = 'session-agent-1';
const agent = (s: ConsoleState, name: string): AgentView | undefined =>
  s.agents.find((a) => a.name === name);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'rein-console-'));

  const a = await createWorld({ dataDir: dir });
  first = a.getState();
  await a.close();

  const b = await createWorld({ dataDir: dir });
  resumed = b.getState();
  // A resumed session-tier agent is only genuinely alive if its ROTATED key can
  // still get a decision out of the engine — assert the rotation end-to-end,
  // not just that the address changed.
  pingOk = await b.pingAgent(agent(resumed, SESSION_AGENT)!.id);
  afterPing = b.getState();
  await b.close();

  const c = await createWorld({ dataDir: dir });
  third = c.getState();
  await c.close();
}, 180_000);

afterAll(async () => {
  // PGlite's emscripten FS can flush a moment after close() resolves; deleting
  // the dir under a straggler surfaces as an unhandled ENOENT (store suite).
  await new Promise((resolve) => setTimeout(resolve, 250));
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {
    // best-effort: a stray temp dir is harmless
  }
});

describe('fresh boot on a store', () => {
  it('tells exactly the same story as the in-memory world', () => {
    // The persistence ports must not change the fingerprint world.test.ts pins;
    // if these drift apart, a store write is altering a payment outcome.
    expect(first.stats.decisions).toBe(11);
    expect(first.stats.allow).toBe(8);
    expect(first.stats.deny).toBe(3);
    expect(first.stats.escalate).toBe(0);
    expect(first.stats.settled).toBe(7);
    expect(Number(first.stats.settledValue)).toBeCloseTo(0.07);
    expect(first.agents.map((a) => a.name).sort()).toEqual([
      'procurement-agent-1',
      'research-agent-1',
      SESSION_AGENT,
    ]);
    expect(first.feed.length).toBeGreaterThan(0);
  });
});

describe('resume', () => {
  it('does not re-seed or replay: the scenario runs once per data directory', () => {
    // The failure this guards is doubling, not zeroing: re-seeding would push
    // the chain to 22 links and mint a research-agent-2 on every restart.
    // Counted off the durable audit chain, not the feed — see the known gap below.
    expect(resumed.stats.chainLinks).toBe(first.stats.chainLinks);
    expect(resumed.stats.agents).toBe(first.stats.agents);
    expect(resumed.agents.map((a) => a.name).sort()).toEqual(
      first.agents.map((a) => a.name).sort(),
    );
    expect(resumed.graph.subjects).toBe(first.graph.subjects);
    expect(resumed.policies).toHaveLength(first.policies.length);
  });

  it('carries the money and the evidence across the restart', () => {
    // The gate view is rebuilt from persisted receipts and counters: not just
    // the totals but the per-route and per-payer breakdown, payer attribution
    // included — which is what proves receipts resumed rather than counters.
    expect(resumed.gate).toEqual(first.gate);
    expect(resumed.gate.settled).toBe(7);
    expect(Number(resumed.gate.revenue)).toBeCloseTo(0.07);
    // Scores are recomputed from the resumed ledger, never stored — the seeded
    // vendors must still land on the same side of the enforcement floor.
    const vendor = (host: string) => resumed.graph.vendors.find((v) => v.id === host);
    expect(vendor('good-feeds.test')!.score).toBeGreaterThan(40);
    expect(vendor('shady-data.test')!.score).toBeLessThan(40);
    expect(resumed.graph.vendors.map((v) => v.id).sort()).toEqual(
      first.graph.vendors.map((v) => v.id).sort(),
    );
  });

  it('drops the feed: telemetry is this process’s, not the world’s state', () => {
    expect(resumed.feed).toEqual([]);
    // Audit surface is rebuilt, not resumed: same pinned engine key, fresh clock.
    expect(resumed.publicKey).toBe(first.publicKey);
    expect(Date.parse(resumed.startedAt)).toBeGreaterThanOrEqual(Date.parse(first.startedAt));
    expect(resumed.demo).toEqual({ running: false, phase: 'idle' });
  });
});

describe('key rotation across boots', () => {
  it('rotates the session-tier wallet and leaves SDK-tier wallets alone', () => {
    const before = agent(first, SESSION_AGENT)!;
    const after = agent(resumed, SESSION_AGENT)!;
    expect(before.mode).toBe('session-key');
    expect(after.mode).toBe('session-key');
    // The custodied private key is never persisted, so the address MUST move.
    expect(after.address).not.toBe(before.address);
    expect(after.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(after.id).toBe(before.id); // same agent, new key
    // SDK-tier runtimes rebuild from the persisted wallet: no rotation.
    for (const name of ['research-agent-1', 'procurement-agent-1']) {
      expect(agent(resumed, name)!.address).toBe(agent(first, name)!.address);
    }
    // Rotation is per boot, not once: the third boot moves it again.
    expect(agent(third, SESSION_AGENT)!.address).not.toBe(after.address);
    expect(agent(third, SESSION_AGENT)!.address).not.toBe(before.address);
  });

  it('keeps one reputation across the rotation instead of minting a stray row', () => {
    // Identity linking folds the new wallet into the existing agent. A missed
    // link shows up as scoreboard growth: one orphan row per boot.
    expect(resumed.graph.agents).toHaveLength(first.graph.agents.length);
    expect(third.graph.agents).toHaveLength(first.graph.agents.length);
    expect(third.graph.subjects).toBe(first.graph.subjects);
    // The offender's verdict is evidence-driven and must survive untouched.
    const offender = (s: ConsoleState) =>
      s.graph.agents.find((a) => a.id === '0xdefec7ed0000000000000000000000000000d00d');
    expect(offender(resumed)!.barred).toBe(true);
    expect(offender(resumed)!.score).toBe(offender(first)!.score);
  });

  it('revokes AND drops the dead grant, so grants do not accrete per boot', () => {
    // S28: a dead grant whose key was never persisted is pure accretion. One
    // live capped session after each boot — checked after TWO rotations, since
    // accretion of one-per-boot only becomes visible on the second.
    for (const s of [first, resumed, third]) {
      expect(s.signer.sessions).toHaveLength(1);
      expect(s.signer.active).toBe(1);
      expect(s.signer.sessions[0]!.status).toBe('active');
      expect(s.signer.sessions[0]!.agentName).toBe(SESSION_AGENT);
    }
    // The fresh grant is a full cap, not the spent remainder of the old one:
    // the scenario spent the first session out exactly (world.test.ts).
    expect(Number(first.signer.sessions[0]!.spent)).toBeCloseTo(0.02);
    expect(Number(resumed.signer.sessions[0]!.spent)).toBe(0);
    expect(resumed.signer.sessions[0]!.cap).toBe(first.signer.sessions[0]!.cap);
    expect(resumed.signer.sessions[0]!.burns).toBe(0);
  });

  it('the rotated key still works: a resumed agent can spend and it persists', () => {
    expect(pingOk).toBe(true);
    // The ping is a real guarded call through the ROTATED session key: it
    // reaches the engine and lands on the audit chain...
    expect(afterPing.stats.chainLinks).toBe(resumed.stats.chainLinks + 1);
    expect(afterPing.feed.length).toBeGreaterThan(0);
    // ...and the NEXT boot resumes with it — the proof the rotated key's spend
    // was durable, not this process's bookkeeping.
    expect(third.stats.chainLinks).toBe(afterPing.stats.chainLinks);
    expect(third.stats.chainLinks).toBe(first.stats.chainLinks + 1);
  });
});

describe('known gap: the headline stats are feed-derived', () => {
  it('zeroes the per-process counters on resume while the durable ones carry over', () => {
    // computeStats() reads decisions/settled/shadow/signature counts off `feed`,
    // which is deliberately per-process. The result is a Stats object that
    // contradicts ITSELF after a restart — 0 decisions beside 11 chain links,
    // $0 settled beside $0.07 of gate revenue for the same 7 receipts, which
    // the Gate panel renders in full next to it.
    //
    // Nothing failed to persist: the world logs "resumed 11 decisions, 9
    // reputation subjects, 3 agents, 1 signer sessions, 7 gate receipts" on the
    // boot these snapshots come from. It is a projection gap, not a
    // persistence one.
    //
    // Pinned deliberately rather than asserted-as-correct: fixing it SHOULD
    // break this test and force the call on which counters are cumulative and
    // which are per-process. Not all of them are the same — avgLatencyMs
    // measures this process's calls, and shadow spends are detected against a
    // mock ledger that is itself ephemeral, so those two have no durable
    // reading to restore.
    for (const k of ['decisions', 'allow', 'deny', 'settled', 'shadow'] as const) {
      expect(first.stats[k]).toBeGreaterThan(0);
      expect(resumed.stats[k]).toBe(0);
    }
    expect(Number(resumed.stats.settledValue)).toBe(0);
    expect(Number(resumed.stats.shadowValue)).toBe(0);
    expect(resumed.stats.sigReleased).toBe(0);
    expect(resumed.stats.sigRefused).toBe(0);

    // The same object's durable fields disagree with all of the above.
    expect(resumed.stats.chainLinks).toBe(11);
    expect(resumed.stats.agents).toBe(3);
    expect(resumed.stats.revenue).toBe(first.stats.revenue);
    expect(resumed.stats.quoted).toBe(first.stats.quoted);
    expect(resumed.stats.gateRefused).toBe(first.stats.gateRefused);
  });
});
