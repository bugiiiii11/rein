import { AnimatePresence, motion } from 'framer-motion';
import type { FeedItem } from '../../server/wire';
import { clockTime, duration, latency, midHash, usd } from '../format';

function verbOf(f: FeedItem): { text: string; cls: string } {
  if (f.kind === 'settled') return { text: 'SETTLED', cls: 'settled' };
  if (f.kind === 'shadow') return { text: 'SHADOW SPEND', cls: 'shadow' };
  if (f.kind === 'unsettled') return { text: 'UNSETTLED', cls: 'shadow' };
  if (f.kind === 'overspent') return { text: 'OVERSPENT', cls: 'shadow' };
  if (f.kind === 'missing') return { text: 'AGENT MISSING', cls: 'shadow' };
  if (f.kind === 'recovered') return { text: 'AGENT BACK', cls: 'allow' };
  if (f.kind === 'quote') return { text: 'QUOTED', cls: 'quote' };
  if (f.kind === 'revenue') return { text: 'REVENUE', cls: 'revenue' };
  if (f.kind === 'gate-refused') return { text: 'TURNED AWAY', cls: 'deny' };
  if (f.kind === 'signature') return { text: 'KEY RELEASED', cls: 'signature' };
  if (f.kind === 'sig-refused') return { text: 'KEY REFUSED', cls: 'deny' };
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
  if (f.kind === 'unsettled') {
    return (
      <div className="feed-sub">
        allowed, never settled · <span className="who">{who}</span> · decision{' '}
        {midHash(f.decisionId, 6, 4)}
      </div>
    );
  }
  if (f.kind === 'overspent') {
    return (
      <div className="feed-sub">
        settled above the {usd(f.allowedAmount)} allowed · <span className="who">{who}</span> ·
        decision {midHash(f.decisionId, 6, 4)}
      </div>
    );
  }
  if (f.kind === 'missing') {
    return (
      <div className="feed-sub">
        silent {duration(f.silentMs)} · expected every {f.interval} ·{' '}
        <span className="who">{who}</span>
      </div>
    );
  }
  if (f.kind === 'recovered') {
    return (
      <div className="feed-sub">
        seen again after {duration(f.silentMs)} · <span className="who">{who}</span>
      </div>
    );
  }
  if (f.kind === 'quote') {
    return (
      <div className="feed-sub">
        x402 offer to an unpaid caller · {f.method ?? 'GET'} {f.resource}
      </div>
    );
  }
  if (f.kind === 'revenue') {
    return (
      <div className="feed-sub">
        route {f.route} · paid by <span className="who">{f.agentName ?? midHash(f.payer, 8, 4)}</span>
      </div>
    );
  }
  if (f.kind === 'gate-refused') {
    return (
      <div className="feed-sub">
        [{f.code}] {f.reason} · <span className="who">{f.agentName ?? midHash(f.payer, 8, 4)}</span>
      </div>
    );
  }
  if (f.kind === 'signature') {
    return (
      <div className="feed-sub">
        <span className="who">{who}</span> · session {midHash(f.sessionId, 6, 4)} · voucher{' '}
        {midHash(f.decisionId, 6, 4)}
      </div>
    );
  }
  if (f.kind === 'sig-refused') {
    return (
      <div className="feed-sub">
        [{f.code}] {f.reason} · <span className="who">{who}</span>
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
  if (f.kind === 'unsettled') return <span className="feed-badge bad">reconciliation</span>;
  if (f.kind === 'overspent') return <span className="feed-badge bad">reconciliation</span>;
  if (f.kind === 'missing') return <span className="feed-badge bad">dead man</span>;
  if (f.kind === 'recovered') return <span className="feed-badge ok">dead man</span>;
  if (f.kind === 'quote') return <span className="feed-badge dim">402</span>;
  if (f.kind === 'revenue') return <span className="feed-badge ok">vendor receipt</span>;
  if (f.kind === 'gate-refused') return <span className="feed-badge bad">gate</span>;
  if (f.kind === 'signature') return <span className="feed-badge ok">EIP-3009</span>;
  if (f.kind === 'sig-refused') return <span className="feed-badge bad">signer</span>;
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
          {/* no amount, no span — usd(undefined) would render a lying "$0.00" */}
          {f.amount !== undefined && <span className="feed-amt">{usd(f.amount)}</span>}
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
