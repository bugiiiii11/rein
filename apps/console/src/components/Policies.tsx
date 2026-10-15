import type { PolicyView } from '../../server/wire';
import { PENDING_ENABLE_TITLE } from './Agents';

function PolicyCard({ p }: { p: PolicyView }) {
  return (
    <div className="policy">
      <div className="policy-top">
        <span className="policy-id">{p.policyId}</span>
        <span className="policy-ver">v{p.version}</span>
        {p.pendingEnable && (
          <span className="tag pending-enable" title={PENDING_ENABLE_TITLE}>
            pending enable
          </span>
        )}
        {p.labels.length > 0 && (
          <span className="policy-labels" title="Targets agents carrying these labels">
            {p.labels.map((l) => `#${l}`).join(' ')}
          </span>
        )}
        <span className="policy-default">default · {p.default}</span>
      </div>
      {p.rules.map((r) => (
        <div className="rule" key={r.id}>
          <span className={`rule-action ${r.action}`}>{r.action}</span>
          <span className="rule-summary">{r.summary}</span>
        </div>
      ))}
    </div>
  );
}

export function Policies({ policies }: { policies: PolicyView[] }) {
  const ordered = [...policies].reverse();
  // A policy that governs only pending agents is installed but not in force.
  const pending = policies.filter((p) => p.pendingEnable).length;
  return (
    <section className="panel grow">
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Policies</span>
        <span className="panel-count">
          {policies.length - pending} active{pending > 0 ? ` · ${pending} pending enable` : ''}
        </span>
      </div>
      <div className="panel-body">
        {ordered.length === 0 ? (
          <div className="empty">No policies installed.</div>
        ) : (
          ordered.map((p) => <PolicyCard key={p.policyId} p={p} />)
        )}
      </div>
    </section>
  );
}
