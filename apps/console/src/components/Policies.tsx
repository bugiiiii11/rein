import type { PolicyView } from '../../server/wire';

function PolicyCard({ p }: { p: PolicyView }) {
  return (
    <div className="policy">
      <div className="policy-top">
        <span className="policy-id">{p.policyId}</span>
        <span className="policy-ver">v{p.version}</span>
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
  return (
    <section className="panel grow">
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Policies</span>
        <span className="panel-count">{policies.length} active</span>
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
