import { useEffect, useRef, useState } from 'react';
import type { AllowanceGapView, FeedItem, ReconciliationView } from '../../server/wire';
import { midHash, usd } from '../format';

/** "3m" — how long the engine has been waiting for this money. */
function age(ms: number): string {
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** One line: what is missing, whose it is, and how to go look it up. */
function Row({ kind, amount, who, where, tail }: {
  kind: string;
  amount: string | undefined;
  who: string;
  where: string;
  tail: string;
}) {
  return (
    <div className="recon-row">
      <span className="recon-chip">{kind}</span>
      <span className="recon-amt">{usd(amount)}</span>
      <span className="recon-who" title={who}>
        {who}
      </span>
      <span className="recon-where" title={where}>
        {where}
      </span>
      <span className="recon-tail">{tail}</span>
    </div>
  );
}

/**
 * Reconciliation: the two ways the allowance ledger and the money can
 * disagree, in one panel because they are one join read in two directions.
 *
 *   - "unsettled" (B1) — the engine said yes and nothing moved. The budget was
 *     charged all the same, which is why this is not cosmetic.
 *   - "shadow" — money moved with no decision behind it, the bypass signal
 *     that drives the upgrade to the signer tier.
 *
 * One line per row, and at most four, for the reason the breaker panel is one
 * line: this column has no spare height, and a taller panel here is paid for
 * out of the audit chain below it. Three-line cards cost the chain 200px.
 *
 * In-flight allowances are counted in the strip but never listed: a payment
 * that settles in the next second is the normal state of every payment, and a
 * panel that listed them would churn constantly and cry wolf by design.
 *
 * `settlementsSeen === 0` is the honest special case. The engine watches no
 * chain — it is TOLD when payments land — so an engine nobody reports to reads
 * every allowance as a gap. That is a wiring fact, not a payments fact, and
 * the panel says which one it is looking at rather than raising an alarm it
 * cannot support.
 */
export function Reconciliation({
  reconciliation,
  feed,
}: {
  reconciliation: ReconciliationView | null;
  feed: FeedItem[];
}) {
  const shadows = feed.filter((f) => f.kind === 'shadow');
  const reporting = (reconciliation?.settlementsSeen ?? 0) > 0;
  const gaps: AllowanceGapView[] = reporting
    ? (reconciliation?.gaps ?? []).filter((g) => g.state === 'unsettled')
    : [];
  const alerts = gaps.length + shadows.length;

  const [flash, setFlash] = useState(false);
  const prevCount = useRef(alerts);

  useEffect(() => {
    if (alerts > prevCount.current) {
      setFlash(true);
      const t = setTimeout(() => setFlash(false), 1100);
      prevCount.current = alerts;
      return () => clearTimeout(t);
    }
    prevCount.current = alerts;
    return undefined;
  }, [alerts]);

  // Unsettled allowances first: an operator is looking for the thing that
  // needs answering, and the shadow list is already history by the time it
  // shows up here.
  const rows = [
    ...gaps.map((g) => (
      <Row
        key={g.intentId}
        kind="unsettled"
        amount={g.amount}
        who={g.agentName}
        where={g.host}
        tail={age(g.ageMs)}
      />
    )),
    ...[...shadows].reverse().map((s) => (
      <Row
        key={s.seq}
        kind="shadow"
        amount={s.amount}
        who={s.agentName ?? s.agentId ?? 'unknown'}
        where={s.chain ?? '—'}
        tail={midHash(s.txHash, 6, 4)}
      />
    )),
  ];

  return (
    <section
      className={`panel ${alerts > 0 ? 'alarm' : ''} ${flash ? 'flash' : ''}`}
      style={{ flex: '0 0 auto' }}
    >
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Reconciliation</span>
        <span className="panel-count">
          {alerts === 0 ? 'all accounted for' : `${alerts} to answer for`}
        </span>
      </div>
      <div className="panel-body" style={{ maxHeight: '18vh', gap: '4px' }}>
        <div
          className="recon-strip"
          title={`Allowances in the last ${reconciliation?.window ?? '24h'}`}
        >
          <span>
            <b>{reconciliation?.allowed ?? 0}</b> allowed
          </span>
          <span>
            <b>{reconciliation?.settled ?? 0}</b> settled
          </span>
          <span>
            <b>{reconciliation?.inFlight ?? 0}</b> in flight
          </span>
          <span className={gaps.length > 0 ? 'is-bad' : ''}>
            <b>{usd(reconciliation?.unsettledValue)}</b> unsettled
          </span>
        </div>

        {!reporting && (reconciliation?.allowed ?? 0) > 0 ? (
          <div className="recon-note">
            No settlement source has reported to this engine, so nothing can be marked settled —
            the allowances above are unconfirmed, not unpaid.
          </div>
        ) : alerts === 0 ? (
          <div className="empty">Every allowance is accounted for, in both directions.</div>
        ) : (
          <>
            {rows.slice(0, 4)}
            {rows.length > 4 && <div className="recon-more">+{rows.length - 4} more</div>}
          </>
        )}
      </div>
    </section>
  );
}
