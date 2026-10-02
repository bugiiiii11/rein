import type { Me } from '../account';
import { TopBar } from './TopBar';

/** A placeholder bar. Width in px or any CSS length. */
function Sk({ w, h }: { w: number | string; h?: number }) {
  return <span className="sk" style={{ width: w, height: h }} />;
}

function SkPanel({ title, rows, grow }: { title: string; rows: number[]; grow?: boolean }) {
  return (
    <section className={`panel ${grow ? 'grow' : ''}`}>
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">{title}</span>
        <span className="panel-count">
          <Sk w={64} h={8} />
        </span>
      </div>
      <div className="panel-body">
        {rows.map((w, i) => (
          <div className="sk-row" key={i}>
            <Sk w={18} h={18} />
            <Sk w={`${w}%`} />
          </div>
        ))}
      </div>
    </section>
  );
}

const KPIS = ['Decisions', 'Allowed', 'Denied', 'Settled', 'Gate revenue', 'Signatures', 'Shadow spend', 'Agents'];

/**
 * The console's frame before the first snapshot: the same bar, the same eight
 * tiles, the same three columns and panel heads as the live layout, so the
 * page lands once and the data fills a frame that is already there. The
 * previous boot state -- one faint line on a bare background, then the whole
 * dashboard at once -- read as a page that had not loaded.
 */
export function Skeleton({ me }: { me: Me }) {
  return (
    <div className="app is-booting" aria-busy="true">
      <TopBar
        booting
        connected={false}
        demo={{ running: false, phase: 'idle' }}
        stats={null}
        chain={null}
        writable={false}
        me={me}
      />
      <div className="kpis">
        {KPIS.map((label) => (
          <div className="kpi" key={label}>
            <span className="kpi-label">{label}</span>
            <span className="kpi-value">
              <Sk w={54} h={20} />
            </span>
            <span className="kpi-sub">
              <Sk w={110} h={8} />
            </span>
          </div>
        ))}
      </div>
      <main className="grid">
        <div className="col left">
          <SkPanel title="Agents" rows={[70, 55]} />
          <SkPanel title="Policies" rows={[80, 62, 74]} />
          <SkPanel title="Breakers" rows={[66]} />
          <SkPanel title="Reputation" rows={[58]} />
        </div>
        <div className="col">
          <SkPanel title="Escalations" rows={[48]} />
          <SkPanel title="Live activity" rows={[72, 64, 78, 58, 70, 66, 74, 60]} grow />
        </div>
        <div className="col right">
          <SkPanel title="Vendor gate" rows={[50]} />
          <SkPanel title="Signer sessions" rows={[56]} />
          <SkPanel title="Reconciliation" rows={[68, 52]} />
          <SkPanel title="Audit chain" rows={[76, 76, 76, 76]} grow />
        </div>
      </main>
    </div>
  );
}
