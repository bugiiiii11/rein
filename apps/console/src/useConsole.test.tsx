/**
 * @vitest-environment happy-dom
 *
 * The console client layer: `useConsole`, the snapshot-and-reconcile hook every
 * panel reads from. The server contract is pinned in `server/api.test.ts`; what
 * matters here is the merge logic no server test can reach — which live items
 * are dropped as replays, what becomes of items that arrive while a snapshot is
 * in flight, and the S28 reconnect heal, whose real job is to stay correct when
 * the world it reconnects to is not the world it left.
 *
 * Both seams are stubbed (EventSource, fetch) because these are races: the
 * interleavings ARE the bug surface, and a real stream cannot be asked to
 * reproduce them on demand.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  AgentView,
  BreakerView,
  ConsoleState,
  ControlPosture,
  FeedItem,
  GateView,
  GraphView,
  PolicyView,
  EscalationsView,
  ReconciliationView,
  ServerEvent,
  Stats,
} from '../server/wire';
import { useConsole, type ConsoleData } from './useConsole';

// ── the two stubbed seams ───────────────────────────────────────────────────

/** A controllable stand-in for the browser's EventSource. */
class FakeEventSource {
  static readonly instances: FakeEventSource[] = [];
  onopen: ((ev: Event) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  private readonly listeners = new Map<string, Set<(ev: Event) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, fn: (ev: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set<(ev: Event) => void>();
    set.add(fn);
    this.listeners.set(type, set);
  }

  removeEventListener(type: string, fn: (ev: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }

  close(): void {
    this.closed = true;
  }

  /** The stream connected. Repeat opens are how the browser reports a reconnect. */
  open(): void {
    this.onopen?.(new Event('open'));
  }

  drop(): void {
    this.onerror?.(new Event('error'));
  }

  /** Push a server event framed exactly as the server frames it (data = event). */
  emit(ev: ServerEvent): void {
    const msg = new MessageEvent(ev.type, { data: JSON.stringify(ev) });
    for (const fn of this.listeners.get(ev.type) ?? []) fn(msg);
  }
}

interface Deferred {
  ok: (state: ConsoleState) => void;
  status: (code: number) => void;
  boom: (message: string) => void;
}

const fetches: Deferred[] = [];
const fetchUrls: string[] = [];
/** What `/api/control` answers this test; `null` makes the request fail. */
let posture: ControlPosture | null = { writable: true, auth: 'none' };

/**
 * Every /api/state call parks here until a test decides how it answers.
 *
 * `/api/control` deliberately does NOT park: posture rides the same snapshot
 * sync, but it is not one of the races under test, and parking it would make
 * every `pending(n)` index mean something different depending on how many
 * syncs had run.
 */
const fetchStub = (input: string): Promise<Response> => {
  fetchUrls.push(input);
  if (input === '/api/control') {
    return posture === null
      ? Promise.reject(new Error('control unreachable'))
      : Promise.resolve({ ok: true, json: async () => posture } as unknown as Response);
  }
  return new Promise<Response>((resolve, reject) => {
    fetches.push({
      ok: (state) => resolve({ ok: true, json: async () => state } as unknown as Response),
      status: (code) => resolve({ ok: false, status: code } as unknown as Response),
      boom: (message) => reject(new Error(message)),
    });
  });
};

/** Snapshot fetches only — the assertions about healing count these. */
const stateUrls = (): string[] => fetchUrls.filter((u) => u === '/api/state');

const pending = (n: number): Deferred => {
  const d = fetches[n];
  if (!d) throw new Error(`no fetch #${n} in flight (saw ${fetches.length})`);
  return d;
};

const stream = (): FakeEventSource => {
  const es = FakeEventSource.instances.at(-1);
  if (!es) throw new Error('no EventSource was opened');
  return es;
};

// ── fixtures ────────────────────────────────────────────────────────────────

const item = (seq: number, over: Partial<FeedItem> = {}): FeedItem => ({
  seq,
  at: '2026-08-28T00:00:00.000Z',
  kind: 'intent',
  ...over,
});

const seqs = (items: FeedItem[]): number[] => items.map((f) => f.seq);

const STATS: Stats = {
  decisions: 0,
  allow: 0,
  deny: 0,
  escalate: 0,
  agents: 0,
  chainLinks: 0,
  revenue: '0',
  quoted: 0,
  gateRefused: 0,
  settled: 0,
  settledValue: '0',
  shadow: 0,
  shadowValue: '0',
  avgLatencyMs: 0,
  sigReleased: 0,
  sigRefused: 0,
};

const GATE: GateView = {
  payTo: '0xvendor',
  network: 'base-sepolia',
  quoted: 0,
  settled: 0,
  refused: 0,
  revenue: '0',
  routes: [],
  payers: [],
};

const GRAPH: GraphView = {
  subjects: 0,
  vendors: [],
  agents: [],
  syncedCount: 0,
  lastSyncAt: null,
  minConfidence: 0.3,
  denyBelow: 60,
};

const AGENT: AgentView = {
  id: 'agt_1',
  name: 'researcher',
  labels: ['research'],
  status: 'active',
  mode: 'sdk',
  chain: 'base-sepolia',
  address: '0xagent',
  spent: '1.50',
  calls: 3,
  createdAt: '2026-08-28T00:00:00.000Z',
};

const POLICY: PolicyView = {
  policyId: 'pol_1',
  version: '1',
  default: 'deny',
  agents: ['agt_1'],
  labels: [],
  rules: [{ id: 'tx-cap', action: 'deny', summary: 'max $5' }],
};

const RECONCILIATION: ReconciliationView = {
  window: '24h',
  graceMs: 60_000,
  allowed: 0,
  allowedValue: '0',
  settled: 0,
  settledValue: '0',
  inFlight: 0,
  inFlightValue: '0',
  unsettled: 0,
  unsettledValue: '0',
  unattributed: 0,
  settlementsSeen: 0,
  gaps: [],
  at: '2026-08-28T00:00:00.000Z',
};

const ESCALATIONS: EscalationsView = {
  approvers: [],
  ttlMs: 600_000,
  pending: [],
  recent: [],
  at: '2026-08-28T00:00:00.000Z',
};

const snapshot = (over: Partial<ConsoleState> = {}): ConsoleState => ({
  feed: [],
  agents: [],
  policies: [],
  stats: STATS,
  gate: GATE,
  signer: { sessions: [], active: 0 },
  graph: GRAPH,
  breakers: [],
  reconciliation: RECONCILIATION,
  escalations: ESCALATIONS,
  demo: { running: false, phase: 'idle' },
  publicKey: 'pk_test',
  startedAt: '2026-08-28T00:00:00.000Z',
  ...over,
});

// ── render harness ──────────────────────────────────────────────────────────

let root: Root | null = null;
let host: HTMLDivElement | null = null;
let latest: ConsoleData | null = null;

function Probe(): null {
  latest = useConsole();
  return null;
}

const data = (): ConsoleData => {
  if (!latest) throw new Error('the hook never rendered');
  return latest;
};

/** Run `fn`, then let every queued microtask and promise chain settle. */
const flush = async (fn: () => void = () => {}): Promise<void> => {
  await act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });
};

const mount = async (): Promise<void> => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Probe));
  });
};

const unmount = async (): Promise<void> => {
  const r = root;
  root = null;
  await act(async () => {
    r?.unmount();
  });
  host?.remove();
  host = null;
};

/** Loaded and connected — the steady state most behaviours start from. */
const boot = async (feed: FeedItem[] = []): Promise<void> => {
  await mount();
  await flush(() => pending(0).ok(snapshot({ feed })));
  await flush(() => stream().open());
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  FakeEventSource.instances.length = 0;
  fetches.length = 0;
  fetchUrls.length = 0;
  posture = { writable: true, auth: 'none' };
  latest = null;
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal('fetch', fetchStub);
});

afterEach(async () => {
  if (root) await unmount();
  vi.unstubAllGlobals();
});

// ── tests ───────────────────────────────────────────────────────────────────

describe('initial load', () => {
  it('opens the stream, then fills from a single snapshot fetch', async () => {
    await mount();

    // Before the snapshot resolves the hook is honest about knowing nothing.
    expect(data().ready).toBe(false);
    expect(data().connected).toBe(false);
    expect(data().stats).toBeNull();
    expect(data().demo).toEqual({ running: false, phase: 'idle' });
    expect(stream().url).toBe('/api/events');
    expect(stateUrls()).toEqual(['/api/state']);

    await flush(() =>
      pending(0).ok(snapshot({ feed: [item(1), item(2)], publicKey: 'pk_world' })),
    );

    expect(data().ready).toBe(true);
    expect(seqs(data().feed)).toEqual([1, 2]);
    expect(data().publicKey).toBe('pk_world');
    expect(data().stats).toEqual(STATS);
    expect(data().error).toBeNull();
  });

  it('does not re-fetch on the FIRST open — only a reconnect heals', async () => {
    await mount();
    await flush(() => pending(0).ok(snapshot()));
    await flush(() => stream().open());

    expect(stateUrls()).toHaveLength(1);
    expect(data().connected).toBe(true);
  });

  it('tracks connection state across a drop and a recovery', async () => {
    await mount();
    await flush(() => pending(0).ok(snapshot()));
    expect(data().connected).toBe(false);

    await flush(() => stream().open());
    expect(data().connected).toBe(true);

    await flush(() => stream().drop());
    expect(data().connected).toBe(false);

    await flush(() => stream().open());
    expect(data().connected).toBe(true);
  });
});

describe('live feed', () => {
  it('appends above the high-water mark and drops replays', async () => {
    await boot([item(1), item(2), item(3)]);

    await flush(() => stream().emit({ type: 'feed', item: item(4) }));
    expect(seqs(data().feed)).toEqual([1, 2, 3, 4]);

    // A redelivery at or below the mark is a duplicate, not news.
    await flush(() => {
      stream().emit({ type: 'feed', item: item(3) });
      stream().emit({ type: 'feed', item: item(4) });
    });
    expect(seqs(data().feed)).toEqual([1, 2, 3, 4]);

    // A gap is not a reason to refuse: the stream is the only source of new
    // items, and the heal — not this handler — is what fills holes.
    await flush(() => stream().emit({ type: 'feed', item: item(9) }));
    expect(seqs(data().feed)).toEqual([1, 2, 3, 4, 9]);
  });

  it('keeps the newest 300, whether they arrive by snapshot or by stream', async () => {
    await boot(Array.from({ length: 320 }, (_, i) => item(i + 1)));
    expect(data().feed).toHaveLength(300);
    expect(seqs(data().feed).at(0)).toBe(21);

    await flush(() => stream().emit({ type: 'feed', item: item(321) }));
    expect(data().feed).toHaveLength(300);
    expect(seqs(data().feed).at(0)).toBe(22);
    expect(seqs(data().feed).at(-1)).toBe(321);
  });

  it('each panel event replaces only its own slice', async () => {
    await boot([item(1)]);

    await flush(() => {
      const es = stream();
      es.emit({ type: 'agents', agents: [AGENT] });
      es.emit({ type: 'policies', policies: [POLICY] });
      es.emit({ type: 'stats', stats: { ...STATS, decisions: 11, chainLinks: 11 } });
      es.emit({ type: 'gate', gate: { ...GATE, settled: 7, revenue: '0.07' } });
      es.emit({ type: 'signer', signer: { sessions: [], active: 2 } });
      es.emit({ type: 'graph', graph: { ...GRAPH, subjects: 4 } });
      es.emit({ type: 'demo', demo: { running: true, phase: 'velocity' } });
    });

    expect(data().agents).toEqual([AGENT]);
    expect(data().policies).toEqual([POLICY]);
    expect(data().stats?.decisions).toBe(11);
    expect(data().gate?.revenue).toBe('0.07');
    expect(data().signer?.active).toBe(2);
    expect(data().graph?.subjects).toBe(4);
    expect(data().demo).toEqual({ running: true, phase: 'velocity' });
    // Panel pushes must not disturb the feed.
    expect(seqs(data().feed)).toEqual([1]);
  });
});

describe('snapshot / stream reconcile', () => {
  it('parks items that arrive mid-fetch, then merges them above the snapshot', async () => {
    await mount();

    // The stream is live before the snapshot lands. These must not be lost...
    await flush(() => {
      const es = stream();
      es.emit({ type: 'feed', item: item(6) }); // out of order on purpose
      es.emit({ type: 'feed', item: item(5) });
      es.emit({ type: 'feed', item: item(3) }); // the snapshot will already have it
    });
    expect(data().feed).toEqual([]); // nothing renders until the snapshot does

    await flush(() =>
      pending(0).ok(snapshot({ feed: [item(1), item(2), item(3), item(4)] })),
    );

    // ...and they land ordered, with the one the snapshot already carried dropped.
    expect(seqs(data().feed)).toEqual([1, 2, 3, 4, 5, 6]);

    // The mark moved to the merged tail: 6 is now a replay, 7 is news.
    await flush(() => {
      stream().emit({ type: 'feed', item: item(6) });
      stream().emit({ type: 'feed', item: item(7) });
    });
    expect(seqs(data().feed)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('heals the gap the stream never replays', async () => {
    await mount();
    await flush(() => pending(0).ok(snapshot({ feed: [item(1)] })));
    await flush(() => stream().open());
    await flush(() => stream().drop());

    // Items 2-4 happened while disconnected; SSE will never resend them.
    await flush(() => stream().open());
    expect(stateUrls()).toHaveLength(2);
    await flush(() =>
      pending(1).ok(snapshot({ feed: [item(1), item(2), item(3), item(4)] })),
    );
    expect(seqs(data().feed)).toEqual([1, 2, 3, 4]);
  });

  it('rebuilds — not merges — when the world it reconnects to has RESTARTED', async () => {
    await mount();
    await flush(() => pending(0).ok(snapshot({ feed: [item(98), item(99), item(100)] })));
    await flush(() => stream().open()); // first open: no heal
    expect(stateUrls()).toHaveLength(1);

    await flush(() => stream().open()); // reconnect: heal
    expect(stateUrls()).toHaveLength(2);

    // A restarted world restarts seq with it. Merging by the old high-water
    // mark would render an empty feed and then silently swallow every live
    // item below 100 for the rest of the session.
    await flush(() => pending(1).ok(snapshot({ feed: [item(1), item(2), item(3)] })));
    expect(seqs(data().feed)).toEqual([1, 2, 3]);

    // The mark came back DOWN with the snapshot, so the new world's next item
    // is accepted rather than judged against a mark it can never reach.
    await flush(() => stream().emit({ type: 'feed', item: item(4) }));
    expect(seqs(data().feed)).toEqual([1, 2, 3, 4]);
  });
});

describe('a failing snapshot', () => {
  it('surfaces the status line and stays unready', async () => {
    await mount();
    await flush(() => pending(0).status(503));

    expect(data().ready).toBe(false);
    expect(data().error).toBe('GET /api/state → 503');
  });

  it('does not wedge the feed, and a later heal clears the error', async () => {
    await mount();
    await flush(() => pending(0).boom('network down'));
    expect(data().error).toBe('network down');

    // If the parking buffer outlived the failure, every later item would be
    // swallowed and the feed would stay frozen for the rest of the session.
    await flush(() => stream().open()); // first open, no heal
    await flush(() => stream().emit({ type: 'feed', item: item(1) }));
    expect(seqs(data().feed)).toEqual([1]);

    await flush(() => stream().open()); // reconnect: retry
    await flush(() => pending(1).ok(snapshot({ feed: [item(1), item(2)] })));
    expect(data().ready).toBe(true);
    expect(data().error).toBeNull();
    expect(seqs(data().feed)).toEqual([1, 2]);
  });
});

describe('teardown', () => {
  it('closes the stream and ignores a snapshot that lands after unmount', async () => {
    await mount();
    const es = stream();
    await unmount();
    expect(es.closed).toBe(true);

    // The in-flight fetch still resolves; the effect must have disarmed it.
    const lastRender = data();
    await flush(() => pending(0).ok(snapshot({ feed: [item(1)] })));
    expect(data()).toBe(lastRender); // no further render happened
    expect(data().ready).toBe(false);
  });
});

describe('control posture', () => {
  it('starts read-only and only opens up when the server says so', async () => {
    await mount();
    // Before any answer lands the hook must not claim it can mutate: a button
    // rendered from an optimistic default is a button that 403s.
    expect(data().control).toEqual({ writable: false, auth: 'none' });

    await flush(() => pending(0).ok(snapshot()));
    expect(data().control).toEqual({ writable: true, auth: 'none' });
  });

  it('reads a keyed console as writable-with-bearer', async () => {
    posture = { writable: true, auth: 'bearer' };
    await mount();
    await flush(() => pending(0).ok(snapshot()));
    expect(data().control).toEqual({ writable: true, auth: 'bearer' });
  });

  it('treats an unreachable /api/control as READ-ONLY, and does not fail the snapshot', async () => {
    posture = null; // the request itself rejects
    await mount();
    await flush(() => pending(0).ok(snapshot({ feed: [item(1)] })));

    // Fail closed on the posture, but the dashboard still loads: a console
    // that cannot report what it allows is still worth reading.
    expect(data().control).toEqual({ writable: false, auth: 'none' });
    expect(data().ready).toBe(true);
    expect(data().error).toBeNull();
    expect(seqs(data().feed)).toEqual([1]);
  });

  it('re-reads posture on the reconnect heal, so a restart into a new posture lands', async () => {
    await boot();
    expect(data().control.writable).toBe(true);

    // The server came back read-only (key removed, public bind).
    posture = { writable: false, auth: 'none' };
    await flush(() => stream().open()); // reconnect
    await flush(() => pending(1).ok(snapshot()));
    expect(data().control).toEqual({ writable: false, auth: 'none' });
  });
});

describe('breakers', () => {
  const BREAKER: BreakerView = {
    agentId: 'agt_1',
    agentName: 'researcher',
    breakerId: 'velocity',
    policyId: 'pol_1',
    window: '24h',
    txCap: 6,
    txCount: 4,
    sum: '0.04',
    countingFrom: '2026-09-09T00:00:00.000Z',
    tripped: false,
  };

  it('arrives in the snapshot and is replaced wholesale by its own event', async () => {
    await mount();
    await flush(() => pending(0).ok(snapshot({ breakers: [BREAKER] })));
    expect(data().breakers).toEqual([BREAKER]);

    const tripped: BreakerView = { ...BREAKER, txCount: 7, tripped: true, reason: 'breaker:velocity' };
    await flush(() => stream().open());
    await flush(() => stream().emit({ type: 'breakers', breakers: [tripped] }));
    expect(data().breakers).toEqual([tripped]);
    // The panel slice is its own: nothing else moved.
    expect(data().stats).toEqual(STATS);
  });
});
