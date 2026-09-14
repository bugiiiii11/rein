import type { EscalationView, EscalationsView } from '../../server/wire';
import { duration, usd } from '../format';

/** The status words, kept short enough to sit in a chip on one line. */
const CHIP: Record<EscalationView['status'], { label: string; tone: string }> = {
  pending: { label: 'parked', tone: 'bad' },
  approved: { label: 'approved', tone: 'ok' },
  rejected: { label: 'rejected', tone: 'dim' },
  expired: { label: 'expired', tone: 'dim' },
};

/**
 * One parked or resolved payment. The title carries what will not fit: the
 * reason, the breakers an approval would reset, and — while it is answerable —
 * the exact bytes to sign.
 */
function Row({ e }: { e: EscalationView }) {
  const chip = CHIP[e.status];
  const tail =
    e.status === 'pending'
      ? `${duration(Math.max(0, e.expiresInMs))} left`
      : e.status === 'expired'
        ? 'denied'
        : (e.approverName ?? 'signed');
  const detail = [
    e.reason,
    e.breakers.length > 0 ? `resets on approval: ${e.breakers.join(', ')}` : '',
    e.challenge ? `sign one of:\n${e.challenge.approve}\n${e.challenge.reject}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  return (
    <div className={`esc-row ${e.status === 'pending' ? 'is-parked' : ''}`}>
      <span className={`esc-chip ${chip.tone}`}>{chip.label}</span>
      <span className="esc-amt">{usd(e.amount)}</span>
      <span className="esc-who" title={e.agentName}>
        {e.agentName}
      </span>
      <span className="esc-where" title={`${e.host}${e.resource}`}>
        {e.host}
      </span>
      <span className="esc-tail" title={detail}>
        {tail}
      </span>
    </div>
  );
}

/**
 * Escalations (A2, rendered for B3): the payments the engine refused to decide
 * on its own authority, and what became of them.
 *
 * This panel is READ-ONLY and that is the feature. An approval is a signature
 * over `decisionId + intentHash` produced by a key the engine has registered,
 * made wherever that private key lives — a laptop, a hardware token, an
 * air-gapped box. A dashboard button that turned a click into a verdict would
 * be exactly the click-to-approve path A2 exists to refuse, and would put the
 * authority to move money behind whatever session cookie this page happens to
 * hold. So the row carries the bytes (hover the countdown) and nothing that
 * could assert anything about them.
 *
 * An empty `approvers` list is the honesty valve, the twin of B1's `settlementsSeen`
 * and B2's `unknown`. With no key registered, a parked payment is not awaiting
 * a human; it is awaiting an expiry, and it will deny. The panel says which of
 * the two it is looking at rather than implying somebody is being asked.
 *
 * One line per row, and at most three. This panel sits above the feed rather
 * than in either side column because that is where the space actually is, and
 * the measurement is the argument: in the left column it took the agent list
 * from 117px to 20px, while the feed is a long scroll list that gives up the
 * same height for the cost of about four rows.
 */
export function Escalations({ escalations }: { escalations: EscalationsView | null }) {
  const pending = escalations?.pending ?? [];
  const recent = escalations?.recent ?? [];
  const approvers = escalations?.approvers ?? [];
  const answerable = approvers.length > 0;

  const rows = [...pending, ...recent];

  return (
    <section className={`panel ${pending.length > 0 ? 'alarm' : ''}`} style={{ flex: '0 0 auto' }}>
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Escalations</span>
        <span
          className="panel-count"
          title={
            answerable
              ? `Registered approvers: ${approvers.map((a) => `${a.name} (${a.id})`).join(', ')}`
              : 'No approver key is registered on this engine'
          }
        >
          {pending.length === 0 ? 'nothing waiting' : `${pending.length} awaiting a signature`}
        </span>
      </div>
      <div className="panel-body" style={{ maxHeight: '16vh', gap: '4px' }}>
        {rows.length === 0 ? (
          <div className="empty">No payment has needed a human. Policy decided every one.</div>
        ) : (
          <>
            {rows.slice(0, 3).map((e) => (
              <Row key={e.decisionId} e={e} />
            ))}
            {rows.length > 3 && <div className="recon-more">+{rows.length - 3} more</div>}
          </>
        )}
        {pending.length > 0 && !answerable && (
          <div
            className="recon-note"
            title="Set REIN_APPROVER_PUBLIC_KEY to register the public half of an approver key. The console never holds a private key; the signature is made wherever that key lives."
          >
            No approver key is registered — nothing here can be signed, and these payments will
            expire into denials.
          </div>
        )}
      </div>
    </section>
  );
}
