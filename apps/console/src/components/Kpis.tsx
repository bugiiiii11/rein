import type { Stats } from '../../server/wire';
import { latency, usd } from '../format';

function Kpi({ label, value, sub, tone }: { label: string; value: string | number; sub: string; tone?: string }) {
  return (
    <div className={`kpi ${tone ?? ''}`}>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      <span className="kpi-sub">{sub}</span>
    </div>
  );
}

export function Kpis({ stats }: { stats: Stats | null }) {
  const s = stats;
  return (
    <div className="kpis">
      <Kpi label="Decisions" value={s?.decisions ?? 0} sub={`${latency(s?.avgLatencyMs)} median`} />
      <Kpi label="Allowed" value={s?.allow ?? 0} sub="cleared to pay" tone="is-ok" />
      <Kpi label="Denied" value={s?.deny ?? 0} sub="blocked pre-pay" tone="is-bad" />
      <Kpi label="Settled" value={usd(s?.settledValue)} sub={`${s?.settled ?? 0} on-chain`} />
      <Kpi label="Shadow spend" value={s?.shadow ?? 0} sub={`${usd(s?.shadowValue)} unreconciled`} tone="is-alarm" />
      <Kpi label="Agents" value={s?.agents ?? 0} sub="under control" />
    </div>
  );
}
