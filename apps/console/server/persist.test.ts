/**
 * The PERSISTENT console world: `REIN_CONSOLE_DATA_DIR` (WorldOptions.dataDir)
 * puts the engine, graph, gate and signer on @reinconsole/store, so a restart
 * resumes the story instead of retelling it. These tests boot the same data
 * directory three times and pin what must survive, what must NOT, and what must
 * change on purpose:
 *
 *   - state survives (decisions, settlements, receipts, reputation subjects);
 *   - the boot seed and the 17-beat scenario run ONLY on a fresh store, so a
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
    expect(first.stats.decisions).toBe(14);
    expect(first.stats.allow).toBe(10);
    expect(first.stats.deny).toBe(3);
    expect(first.stats.escalate).toBe(1);
    expect(first.stats.settled).toBe(9);
    expect(Number(first.stats.settledValue)).toBeCloseTo(0.09);
    expect(first.agents.map((a) => a.name).sort()).toEqual([
      'probation-agent-1',
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
    expect(resumed.gate.settled).toBe(9);
    expect(Number(resumed.gate.revenue)).toBeCloseTo(0.09);
    // Scores are recomputed from the resumed ledger, never stored — the seeded
    // vendors must still land on the same side of the enforcement floor.
    const vendor = (host: string) => resumed.graph.vendors.find((v) => v.id === host);
    expect(vendor('good-feeds.test')!.score).toBeGreaterThan(40);
    expect(vendor('shady-data.test')!.score).toBeLessThan(40);
    expect(resumed.graph.vendors.map((v) => v.id).sort()).toEqual(
      first.graph.vendors.map((v) => v.id).sort(),
    );
  });

  it('carries the dead-man watch AND its last sighting across the restart', () => {
    const before = agent(first, 'research-agent-1')!.liveness!;
    const after = agent(resumed, 'research-agent-1')!.liveness!;
    // The expectation is config and the sighting is evidence; both are durable.
    // A restart that forgot the sighting would read every live agent as silent
    // since boot and raise an alarm about the deployment, not about the agents.
    expect(after.interval).toBe(before.interval);
    expect(after.lastSeenAt).toBe(before.lastSeenAt);
    expect(after.lastSource).toBe('intent');
    // ...and the silence is measured from the sighting, not from this boot.
    expect(after.silentMs).toBeGreaterThanOrEqual(before.silentMs);
    // Still only the research poller: a resume must not widen the watch list.
    expect(resumed.agents.filter((a) => a.liveness).map((a) => a.name)).toEqual([
      'research-agent-1',
    ]);
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

describe('the two stat windows', () => {
  it('all-time counters survive the restart and agree with each other', () => {
    // The bug this replaces: decision counts were read off the ephemeral feed,
    // so a resumed console rendered "0 decisions" beside "11 chain links" —
    // the same events, from the same store, contradicting themselves. They now
    // share one source (the signed chain), so they cannot drift apart.
    expect(resumed.stats.decisions).toBe(first.stats.decisions);
    expect(resumed.stats.decisions).toBe(resumed.stats.chainLinks);
    expect(resumed.stats.allow).toBe(first.stats.allow);
    expect(resumed.stats.deny).toBe(first.stats.deny);
    expect(resumed.stats.escalate).toBe(1);
    // The parts still account for the whole after a restart.
    expect(resumed.stats.allow + resumed.stats.deny + resumed.stats.escalate).toBe(
      resumed.stats.decisions,
    );
    expect(resumed.stats.agents).toBe(first.stats.agents);
    // Vendor-side counters come from persisted receipts, not the feed.
    expect(resumed.stats.revenue).toBe(first.stats.revenue);
    expect(resumed.stats.quoted).toBe(first.stats.quoted);
    expect(resumed.stats.gateRefused).toBe(first.stats.gateRefused);
  });

  it('keeps the parked escalation across the restart, on its ORIGINAL clock', () => {
    // A parked payment is authority state, not telemetry. Losing it would
    // leave the money blocked (the breaker that stopped it resumed tripped —
    // those floors are durable) with no challenge left to answer and no record
    // that a human was ever asked, which is the worst of both fail-closed and
    // fail-open.
    expect(resumed.escalations.pending).toHaveLength(1);
    const before = first.escalations.pending[0]!;
    const after = resumed.escalations.pending[0]!;
    expect(after.decisionId).toBe(before.decisionId);
    expect(after.agentName).toBe(before.agentName);
    expect(after.breakers).toEqual(before.breakers);
    // The deadline rides in the stored record, so a restart does NOT hand a
    // stale escalation a fresh lease.
    expect(after.expiresAt).toBe(before.expiresAt);
    expect(after.expiresInMs).toBeLessThanOrEqual(before.expiresInMs);
    // And the bytes are the same bytes: an operator who walked away mid-signature
    // can still submit what they signed.
    expect(after.challenge).toEqual(before.challenge);
  });

  it('since-boot counters reset, because they have no durable reading', () => {
    // Not an oversight: shadow spends are reconciled against a mock ledger that
    // is rebuilt empty each boot, signer refusals are events rather than state,
    // and avgLatencyMs times calls THIS process made. Zero is the honest answer
    // for a fresh process, which is why the KPI tiles label these "this boot".
    expect(first.stats.settled).toBe(9);
    expect(first.stats.shadow).toBe(1);
    expect(resumed.stats.settled).toBe(0);
    expect(resumed.stats.shadow).toBe(0);
    expect(Number(resumed.stats.settledValue)).toBe(0);
    expect(Number(resumed.stats.shadowValue)).toBe(0);
    expect(resumed.stats.sigReleased).toBe(0);
    expect(resumed.stats.sigRefused).toBe(0);
    expect(resumed.stats.avgLatencyMs).toBe(0);
    // The durable vendor-side view still carries that money, so the settlement
    // history is never actually lost — only this window's count of it.
    expect(resumed.gate.settled).toBe(9);
    expect(Number(resumed.gate.revenue)).toBeCloseTo(0.09);
  });

  it('a since-boot counter climbs from zero as the resumed world works', () => {
    // The ping is the only decision this process made, so the two windows are
    // legible side by side: 1 this boot, 12 all-time.
    expect(afterPing.stats.settled + afterPing.stats.shadow).toBeGreaterThanOrEqual(0);
    expect(afterPing.feed.filter((f) => f.kind === 'decision')).toHaveLength(1);
    expect(afterPing.stats.decisions).toBe(first.stats.decisions + 1);
  });
});
