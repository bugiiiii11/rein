import { useEffect, useRef, useState } from 'react';
import type {
  AgentView,
  BreakerView,
  ControlPosture,
  DemoStatus,
  FeedItem,
  GateView,
  GraphView,
  PolicyView,
  SignerView,
  Stats,
} from '../server/wire';
import { fetchControl, fetchState } from './api';

export interface ConsoleData {
  ready: boolean;
  connected: boolean;
  feed: FeedItem[]; // chronological, oldest first
  agents: AgentView[];
  policies: PolicyView[];
  stats: Stats | null;
  gate: GateView | null;
  signer: SignerView | null;
  graph: GraphView | null;
  breakers: BreakerView[];
  demo: DemoStatus;
  publicKey: string;
  startedAt: string;
  /** Whether this console accepts mutations at all (GET /api/control). */
  control: ControlPosture;
  error: string | null;
}

const EMPTY_DEMO: DemoStatus = { running: false, phase: 'idle' };
const FEED_CAP = 300;

const parse = <T>(ev: Event): T => JSON.parse((ev as MessageEvent).data) as T;

export function useConsole(): ConsoleData {
  const [data, setData] = useState<ConsoleData>({
    ready: false,
    connected: false,
    feed: [],
    agents: [],
    policies: [],
    stats: null,
    gate: null,
    signer: null,
    graph: null,
    breakers: [],
    demo: EMPTY_DEMO,
    publicKey: '',
    startedAt: '',
    // Assume read-only until the server says otherwise — the same fail-closed
    // default the server itself boots with.
    control: { writable: false, auth: 'none' },
    error: null,
  });
  const maxSeq = useRef(0);

  useEffect(() => {
    let cancelled = false;
    // While a snapshot fetch is in flight, live feed items park here so the
    // reconcile below can merge them by seq instead of racing the fetch.
    let pending: FeedItem[] | null = null;
    let firstOpen = true;

    /**
     * Snapshot-and-reconcile: the initial load, and the heal after an SSE
     * reconnect. A server restart resets seq, so the feed (and maxSeq) is
     * REBUILT from the snapshot — merging by seq would silently drop
     * everything the new world emits below the old high-water mark.
     */
    const sync = async () => {
      pending = [];
      try {
        // Posture rides the snapshot rather than a one-shot boot fetch, so a
        // server that restarts into a different posture (a key added, a bind
        // changed) is picked up by the same reconnect heal as the feed.
        const [s, control] = await Promise.all([fetchState(), fetchControl()]);
        if (cancelled) return;
        const snapMax = s.feed.reduce((m, f) => Math.max(m, f.seq), 0);
        const extra = (pending ?? [])
          .filter((f) => f.seq > snapMax)
          .sort((a, b) => a.seq - b.seq);
        const feed = [...s.feed, ...extra].slice(-FEED_CAP);
        maxSeq.current = feed.reduce((m, f) => Math.max(m, f.seq), 0);
        setData((d) => ({
          ...d,
          ready: true,
          feed,
          agents: s.agents,
          policies: s.policies,
          stats: s.stats,
          gate: s.gate,
          signer: s.signer,
          graph: s.graph,
          breakers: s.breakers,
          demo: s.demo,
          publicKey: s.publicKey,
          startedAt: s.startedAt,
          control,
          error: null,
        }));
      } catch (e) {
        if (!cancelled) setData((d) => ({ ...d, error: e instanceof Error ? e.message : String(e) }));
      } finally {
        pending = null;
      }
    };

    const es = new EventSource('/api/events');
    es.onopen = () => {
      if (cancelled) return;
      setData((d) => ({ ...d, connected: true }));
      // EventSource auto-reconnected (dev-server restart, network blip):
      // re-snapshot to heal the feed gap the stream never replays.
      if (firstOpen) {
        firstOpen = false;
        return;
      }
      void sync();
    };
    es.onerror = () => {
      if (!cancelled) setData((d) => ({ ...d, connected: false }));
    };
    es.addEventListener('feed', (ev) => {
      const { item } = parse<{ item: FeedItem }>(ev);
      if (pending) {
        pending.push(item);
        return;
      }
      if (item.seq <= maxSeq.current) return;
      maxSeq.current = item.seq;
      setData((d) => ({ ...d, feed: [...d.feed, item].slice(-FEED_CAP) }));
    });
    es.addEventListener('agents', (ev) =>
      setData((d) => ({ ...d, agents: parse<{ agents: AgentView[] }>(ev).agents })),
    );
    es.addEventListener('policies', (ev) =>
      setData((d) => ({ ...d, policies: parse<{ policies: PolicyView[] }>(ev).policies })),
    );
    es.addEventListener('stats', (ev) =>
      setData((d) => ({ ...d, stats: parse<{ stats: Stats }>(ev).stats })),
    );
    es.addEventListener('gate', (ev) =>
      setData((d) => ({ ...d, gate: parse<{ gate: GateView }>(ev).gate })),
    );
    es.addEventListener('signer', (ev) =>
      setData((d) => ({ ...d, signer: parse<{ signer: SignerView }>(ev).signer })),
    );
    es.addEventListener('graph', (ev) =>
      setData((d) => ({ ...d, graph: parse<{ graph: GraphView }>(ev).graph })),
    );
    es.addEventListener('breakers', (ev) =>
      setData((d) => ({ ...d, breakers: parse<{ breakers: BreakerView[] }>(ev).breakers })),
    );
    es.addEventListener('demo', (ev) =>
      setData((d) => ({ ...d, demo: parse<{ demo: DemoStatus }>(ev).demo })),
    );
    void sync();

    return () => {
      cancelled = true;
      es.close();
    };
  }, []);

  return data;
}
