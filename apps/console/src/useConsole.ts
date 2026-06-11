import { useEffect, useRef, useState } from 'react';
import type {
  AgentView,
  DemoStatus,
  FeedItem,
  GateView,
  GraphView,
  PolicyView,
  Stats,
} from '../server/wire';
import { fetchState } from './api';

export interface ConsoleData {
  ready: boolean;
  connected: boolean;
  feed: FeedItem[]; // chronological, oldest first
  agents: AgentView[];
  policies: PolicyView[];
  stats: Stats | null;
  gate: GateView | null;
  graph: GraphView | null;
  demo: DemoStatus;
  publicKey: string;
  startedAt: string;
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
    graph: null,
    demo: EMPTY_DEMO,
    publicKey: '',
    startedAt: '',
    error: null,
  });
  const maxSeq = useRef(0);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;

    void (async () => {
      try {
        const s = await fetchState();
        if (cancelled) return;
        maxSeq.current = s.feed.reduce((m, f) => Math.max(m, f.seq), 0);
        setData((d) => ({
          ...d,
          ready: true,
          feed: s.feed,
          agents: s.agents,
          policies: s.policies,
          stats: s.stats,
          gate: s.gate,
          graph: s.graph,
          demo: s.demo,
          publicKey: s.publicKey,
          startedAt: s.startedAt,
        }));
      } catch (e) {
        if (!cancelled) setData((d) => ({ ...d, error: e instanceof Error ? e.message : String(e) }));
      }
      if (cancelled) return;

      es = new EventSource('/api/events');
      es.onopen = () => setData((d) => ({ ...d, connected: true }));
      es.onerror = () => setData((d) => ({ ...d, connected: false }));
      es.addEventListener('feed', (ev) => {
        const { item } = parse<{ item: FeedItem }>(ev);
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
      es.addEventListener('graph', (ev) =>
        setData((d) => ({ ...d, graph: parse<{ graph: GraphView }>(ev).graph })),
      );
      es.addEventListener('demo', (ev) =>
        setData((d) => ({ ...d, demo: parse<{ demo: DemoStatus }>(ev).demo })),
      );
    })();

    return () => {
      cancelled = true;
      es?.close();
    };
  }, []);

  return data;
}
