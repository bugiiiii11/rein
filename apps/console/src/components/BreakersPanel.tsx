import type { BreakerView } from '../../server/wire';
import { usd } from '../format';

/** How far into the envelope one tripwire is, 0-1 (clamped for the bar). */
function fraction(used: number, cap: number): number {
  if (cap <= 0) return 0;
  return Math.min(1, used / cap);
}

/**
 * One tripwire, inline. Tone tracks PROXIMITY, not just the trip: the whole
 * value of showing this is seeing the envelope fill before a human gets asked
 * a question.
 */
function Wire({ label, used, cap, pct }: { label: string; used: string; cap: string; pct: number }) {
  const v = Math.round(pct * 100);
  const color = v >= 100 ? 'var(--bad)' : v >= 70 ? 'var(--accent)' : 'var(--ok)';
  return (
    <span className="brk-wire" title={`${label}: ${used} of ${cap}`}>
      <span className="brk-wire-track">
        <span className="brk-wire-fill" style={{ width: `${Math.min(100, v)}%`, background: color }} />
      </span>
      <span className="brk-wire-num">
        {used}
        <span className="brk-dim">/{cap}</span>
      </span>
    </span>
  );
}

function BreakerRow({ b }: { b: BreakerView }) {
  return (
    <div className={`brk-row ${b.tripped ? 'is-tripped' : ''}`}>
      <div className="brk-line">
        <span className={`brk-chip ${b.tripped ? 'bad' : 'ok'}`}>{b.tripped ? 'trip' : 'armed'}</span>
        <span className="brk-name" title={`${b.breakerId} · ${b.policyId}`}>
          {b.breakerId}
        </span>
        <span className="brk-agent" title={b.agentName}>
          {b.agentName}
        </span>
        {b.txCap !== undefined && (
          <Wire
            label="calls"
            used={String(b.txCount)}
            cap={String(b.txCap)}
            pct={fraction(b.txCount, b.txCap)}
          />
        )}
        {b.valueCap !== undefined && (
          <Wire
            label="spend"
            used={usd(b.sum)}
            cap={usd(b.valueCap)}
            pct={fraction(Number(b.sum), Number(b.valueCap))}
          />
        )}
        <span className="brk-window">{b.window}</span>
      </div>
      {b.tripped && b.reason && <div className="brk-reason">{b.reason}</div>}
      {b.resetAt && (
        <div className="brk-reset" title="A signed approval moved the counting floor to this instant">
          floor moved by approval · {new Date(b.resetAt).toLocaleTimeString()}
        </div>
      )}
    </div>
  );
}

/**
 * Behavioral breakers, rendered (A3): the envelope each agent is operating
 * inside, and how close it is to the edge.
 *
 * Two things this panel is careful to state honestly. A breaker ESCALATES, it
 * never denies — "trip" means the next payment asks a human, not that the
 * agent is cut off. And the counters are a FLOOR, not a running total: the
 * span starts at the later of the window edge and the last signed reset, which
 * is why an approval needs no counter wipe and nothing is ever cleaned up.
 *
 * One line per breaker, deliberately: this dashboard has no spare vertical
 * space at any realistic viewport, and a taller panel here is paid for out of
 * the agent list or the audit chain.
 */
export function BreakersPanel({ breakers }: { breakers: BreakerView[] }) {
  // Tripped first — the thing an operator is looking for should never be
  // below the fold behind a list of healthy agents.
  const ordered = [...breakers].sort((a, b) => Number(b.tripped) - Number(a.tripped));
  const tripped = breakers.filter((b) => b.tripped).length;

  return (
    <section className="panel" style={{ flex: '0 0 auto' }}>
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Breakers</span>
        <span className="panel-count">
          {breakers.length} armed{tripped > 0 ? ` · ${tripped} tripped` : ''}
        </span>
      </div>
      <div className="panel-body" style={{ maxHeight: '16vh' }}>
        {ordered.length === 0 ? (
          <div className="empty">No breakers in policy — nothing to watch.</div>
        ) : (
          ordered.map((b) => <BreakerRow key={`${b.agentId}:${b.breakerId}`} b={b} />)
        )}
      </div>
    </section>
  );
}
