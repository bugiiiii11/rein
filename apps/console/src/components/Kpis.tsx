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

/**
 * Stats carries two windows (see server/wire.ts): all-time counters rebuilt
 * from durable state, and counters that only cover this process. On a
 * persistent world the two diverge the moment it restarts, so every since-boot
 * tile says so in its sub-label — an unlabelled "0 settled" next to an
 * all-time "$0.07 gate revenue" reads as a bug rather than two windows.
 */
export function Kpis({ stats }: { stats: Stats | null }) {
  const s = stats;
  return (
    <div className="kpis">
      <Kpi
        label="Decisions"
        value={s?.decisions ?? 0}
        sub={`on the signed chain · ${latency(s?.avgLatencyMs)} avg this boot`}
      />
      <Kpi label="Allowed" value={s?.allow ?? 0} sub="cleared to pay" tone="is-ok" />
      <Kpi label="Denied" value={s?.deny ?? 0} sub="blocked pre-pay" tone="is-bad" />
      <Kpi
        label="Settled"
        value={usd(s?.settledValue)}
        sub={`${s?.settled ?? 0} on-chain · this boot`}
      />
      <Kpi
        label="Gate revenue"
        value={usd(s?.revenue)}
        sub={`${s?.quoted ?? 0} quoted · ${s?.gateRefused ?? 0} refused`}
        tone="is-accent"
      />
      <Kpi
        label="Signatures"
        value={s?.sigReleased ?? 0}
        sub={`${s?.sigRefused ?? 0} refused · this boot`}
        tone="is-ok"
      />
      <Kpi
        label="Shadow spend"
        value={s?.shadow ?? 0}
        sub={`${usd(s?.shadowValue)} unreconciled · this boot`}
        tone="is-alarm"
      />
      <Kpi label="Agents" value={s?.agents ?? 0} sub="under control" />
    </div>
  );
}
