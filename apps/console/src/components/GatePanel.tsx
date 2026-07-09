import type { GateView } from '../../server/wire';
import { midHash, usd } from '../format';

const TOP_N = 6;

/** Top-N lines by revenue; the tail collapses into a muted "+N more". */
function top<T extends { revenue: string }>(lines: T[]): { shown: T[]; more: number } {
  const sorted = [...lines].sort((a, b) => Number(b.revenue) - Number(a.revenue));
  return { shown: sorted.slice(0, TOP_N), more: Math.max(0, sorted.length - TOP_N) };
}

/**
 * The vendor side of the wire: what the world's gated API is earning. Revenue
 * headline, then per-route and per-payer breakdowns from the gate's receipts.
 */
export function GatePanel({ gate }: { gate: GateView | null }) {
  const g = gate;
  const routes = top(g?.routes ?? []);
  const payers = top(g?.payers ?? []);
  return (
    <section className="panel" style={{ flex: '0 0 auto' }}>
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Vendor Gate</span>
        <span className="panel-count">
          {g?.settled ?? 0} settled · {g?.refused ?? 0} refused
        </span>
      </div>
      <div className="panel-body" style={{ maxHeight: '36vh' }}>
        <div className="gate-headline">
          <div>
            <span className="gate-revenue">{usd(g?.revenue)}</span>
            <span className="gate-revenue-label">earned · USDC</span>
          </div>
          <div className="gate-meta">
            <span>{g?.quoted ?? 0} quotes issued</span>
            <span>
              pays {midHash(g?.payTo, 6, 4)} · {g?.network ?? '—'}
            </span>
          </div>
        </div>
        {routes.shown.length > 0 && (
          <div className="gate-section">
            <div className="gate-section-title">Priced routes</div>
            {routes.shown.map((r) => (
              <div className="gate-row" key={r.route}>
                <span className="gate-row-name">{r.route}</span>
                <span className="gate-row-count">{r.settled}×</span>
                <span className="gate-row-amt">{usd(r.revenue)}</span>
              </div>
            ))}
            {routes.more > 0 && <div className="gate-more">+{routes.more} more</div>}
          </div>
        )}
        {payers.shown.length > 0 && (
          <div className="gate-section">
            <div className="gate-section-title">Paying wallets</div>
            {payers.shown.map((p) => (
              <div className="gate-row" key={p.payer}>
                <span className="gate-row-name">{p.agentName ?? midHash(p.payer, 8, 4)}</span>
                <span className="gate-row-count">{p.settled}×</span>
                <span className="gate-row-amt">{usd(p.revenue)}</span>
              </div>
            ))}
            {payers.more > 0 && <div className="gate-more">+{payers.more} more</div>}
          </div>
        )}
        {!g && <div className="empty">No gate in this world.</div>}
      </div>
    </section>
  );
}
