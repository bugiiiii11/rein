import type { SignerSessionView, SignerView } from '../../server/wire';
import { midHash, usd } from '../format';

const MAX_ROWS = 6;

const TONE: Record<SignerSessionView['status'], string> = {
  active: 'ok',
  expired: 'dim',
  revoked: 'bad',
};

/**
 * The custody tier, rendered: every session-key grant the signer has minted —
 * who holds it, the wallet it spends from, how much of its cap has been signed
 * for, and whether the grant is still live. Revoked rows are the kill switch
 * and key rotation made visible.
 */
export function SignerPanel({ signer }: { signer: SignerView | null }) {
  const sessions = signer?.sessions ?? [];
  const shown = sessions.slice(0, MAX_ROWS);
  return (
    <section className="panel" style={{ flex: '0 0 auto' }}>
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Signer Sessions</span>
        <span className="panel-count">
          {signer?.active ?? 0} active · {sessions.length} grants
        </span>
      </div>
      <div className="panel-body" style={{ maxHeight: '30vh' }}>
        {shown.length > 0 && (
          <div className="gate-section">
            <div className="gate-section-title">Session keys in custody</div>
            {shown.map((s) => (
              <div className="gate-row" key={s.id}>
                <span className="gate-row-name" title={`${s.wallet} · session ${s.id}`}>
                  {s.agentName ?? midHash(s.agentId, 6, 4)} · {midHash(s.wallet, 6, 4)}
                </span>
                <span className="gate-row-count" title="signatures released">
                  {s.burns}×
                </span>
                <span className="gate-row-amt" style={{ whiteSpace: 'nowrap' }} title="signed for / session cap">
                  {usd(s.spent)}/{s.cap !== undefined ? usd(s.cap) : '∞'}
                </span>
                <span className={`feed-badge ${TONE[s.status]}`}>{s.status}</span>
              </div>
            ))}
            {sessions.length > MAX_ROWS && (
              <div className="gate-more">+{sessions.length - MAX_ROWS} more</div>
            )}
          </div>
        )}
        {sessions.length === 0 && <div className="empty">No session keys in custody yet.</div>}
      </div>
    </section>
  );
}
