import { useEffect, useRef, useState } from 'react';
import type { FeedItem } from '../../server/wire';
import { clockTime, midHash, usd } from '../format';

export function Shadow({ feed }: { feed: FeedItem[] }) {
  const shadows = feed.filter((f) => f.kind === 'shadow');
  const [flash, setFlash] = useState(false);
  const prevCount = useRef(shadows.length);

  useEffect(() => {
    if (shadows.length > prevCount.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1100);
      prevCount.current = shadows.length;
      return () => clearTimeout(t);
    }
    prevCount.current = shadows.length;
    return undefined;
  }, [shadows.length]);

  const recent = [...shadows].slice(-6).reverse();

  return (
    <section className={`panel alarm ${flash ? 'flash' : ''}`} style={{ flex: '0 0 auto' }}>
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Shadow Spends</span>
        <span className="panel-count">{shadows.length} detected</span>
      </div>
      <div className="panel-body" style={{ maxHeight: '34vh' }}>
        {recent.length === 0 ? (
          <div className="empty">No bypass detected — every payment is governed.</div>
        ) : (
          recent.map((s) => (
            <div className="shadow-card" key={s.seq}>
              <div className="shadow-top">
                <span className="shadow-glyph">⚠</span>
                <span className="shadow-title">Unreconciled spend</span>
                <span className="shadow-amt">{usd(s.amount)}</span>
              </div>
              <div className="shadow-line">
                {s.agentName ?? s.agentId} · {s.chain} · {clockTime(s.at)}
              </div>
              <div className="shadow-line">tx {midHash(s.txHash, 10, 6)}</div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}
