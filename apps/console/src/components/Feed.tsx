import { AnimatePresence, motion } from 'framer-motion';
import type { FeedItem } from '../../server/wire';
import { clockTime, latency, midHash, usd } from '../format';

function verbOf(f: FeedItem): { text: string; cls: string } {
  if (f.kind === 'settled') return { text: 'SETTLED', cls: 'settled' };
  if (f.kind === 'shadow') return { text: 'SHADOW SPEND', cls: 'shadow' };
  return { text: (f.outcome ?? 'decision').toUpperCase(), cls: f.outcome ?? '' };
}

function Sub({ f }: { f: FeedItem }) {
  const who = f.agentName ?? f.agentId ?? 'unknown';
  if (f.kind === 'settled') {
    return (
      <div className="feed-sub">
        tx {midHash(f.txHash, 8, 6)} · block {f.blockNumber ?? '—'} · <span className="who">{who}</span>
      </div>
    );
  }
  if (f.kind === 'shadow') {
    return (
      <div className="feed-sub">
        unguarded transfer · <span className="who">{who}</span> · {f.chain}
      </div>
    );
  }
  if (f.outcome === 'allow') {
    return (
      <div className="feed-sub">
        <span className="who">{who}</span> · policy {f.policyId}
      </div>
    );
  }
  return (
    <div className="feed-sub">
      {f.reason ?? 'blocked'} · <span className="who">{who}</span>
    </div>
  );
}

function Right({ f }: { f: FeedItem }) {
  if (f.kind === 'decision') return <span className="mono">{latency(f.latencyMs)}</span>;
  if (f.kind === 'settled') return <span className="feed-badge">on-chain</span>;
  return <span style={{ color: 'var(--alarm)' }}>⚠ flagged</span>;
}

function Row({ f }: { f: FeedItem }) {
  const verb = verbOf(f);
  return (
    <>
      <span className="feed-time">{clockTime(f.at)}</span>
      <div className="feed-main">
        <div className="feed-title">
          <span className={`feed-verb ${verb.cls}`}>{verb.text}</span>
          <span className="feed-amt">{usd(f.amount)}</span>
          {f.host && (
            <>
              <span className="feed-arrow">→</span>
              <span className="feed-host">{f.host}</span>
            </>
          )}
        </div>
        <Sub f={f} />
      </div>
      <div className="feed-right">
        <Right f={f} />
      </div>
    </>
  );
}

export function Feed({ feed }: { feed: FeedItem[] }) {
  const rows = [...feed].slice(-140).reverse();
  return (
    <section className="panel grow">
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Live Activity</span>
        <span className="panel-count">{feed.length} events</span>
      </div>
      <ul className="panel-body flush feed">
        {rows.length === 0 ? (
          <li className="empty">Waiting for activity — run a scenario.</li>
        ) : (
          <AnimatePresence initial={false}>
            {rows.map((f) => (
              <motion.li
                key={f.seq}
                className="feed-row"
                data-kind={f.kind}
                data-outcome={f.outcome ?? ''}
                initial={{ opacity: 0, y: -10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.28, ease: 'easeOut' }}
              >
                <Row f={f} />
              </motion.li>
            ))}
          </AnimatePresence>
        )}
      </ul>
    </section>
  );
}
