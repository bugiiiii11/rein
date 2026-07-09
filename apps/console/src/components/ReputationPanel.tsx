import { useState } from 'react';
import type { GraphView, ReputationRow } from '../../server/wire';
import { midHash, usd } from '../format';

const DAY_MS = 86_400_000;
const MAX_AGENT_ROWS = 6;

/** Chip tone mirrors the enforcement rules: dim when the graph would not act
 * on the score (confidence below the floor), rose when enforcement bites. */
function chipTone(r: ReputationRow, g: GraphView): string {
  if (r.confidence < g.minConfidence) return 'thin';
  if (r.score < g.denyBelow) return 'bad';
  return r.score >= 70 ? 'ok' : 'mid';
}

function nameOf(r: ReputationRow): string {
  if (r.label) return r.label;
  if (r.id.startsWith('0x')) return midHash(r.id, 6, 4);
  return r.id.length > 18 ? midHash(r.id, 8, 4) : r.id;
}

function knownFor(iso: string): string {
  const days = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / DAY_MS));
  return days === 0 ? 'known today' : `known ${days}d`;
}

function Meter({ label, value }: { label: string; value: number }) {
  const v = Math.round(value);
  const color = v >= 70 ? 'var(--ok)' : v >= 40 ? 'var(--accent)' : 'var(--bad)';
  return (
    <div className="rep-meter">
      <span>{label}</span>
      <span className="rep-meter-track">
        <span className="rep-meter-fill" style={{ width: `${v}%`, background: color }} />
      </span>
      <span className="rep-meter-num">{v}</span>
    </div>
  );
}

function Row({ r, g, open, onToggle }: { r: ReputationRow; g: GraphView; open: boolean; onToggle: () => void }) {
  return (
    <div className="rep-row">
      <button className="rep-line" onClick={onToggle} title="show the evidence behind this score">
        <span className={`rep-chip ${chipTone(r, g)}`}>{r.score}</span>
        <span className="rep-name">{nameOf(r)}</span>
        {r.erc8004 && <span className="rep-badge dim" title={r.id}>erc-8004</span>}
        {r.synced && <span className="rep-badge engine">→ engine</span>}
        {r.barred && <span className="rep-badge barred">barred</span>}
        {!r.barred && !r.synced && r.confidence < g.minConfidence && (
          <span className="rep-badge dim">unenforced</span>
        )}
        <span className="rep-conf">{Math.round(r.confidence * 100)}%</span>
      </button>
      {open && (
        <div className="rep-detail">
          <Meter label="reliability" value={r.components.settlementReliability} />
          <Meter label="hygiene" value={r.components.disputeRate} />
          <Meter label="volume" value={r.components.volume} />
          <Meter label="peers" value={r.components.counterpartyQuality} />
          <Meter label="tenure" value={r.components.longevity} />
          <div className="rep-evidence">
            {r.attempts} attempts · {r.settled} settled · {usd(r.volume)}
            {r.disputes > 0 && <> · {r.disputes} disputes</>}
            {r.refusals > 0 && <> · {r.refusals} refusals</>}
            {r.shadowSpends > 0 && <> · {r.shadowSpends} shadow</>}
            {r.endorsements > 0 && <> · {r.endorsements} vouches</>}
            {' · '}
            {knownFor(r.firstSeen)}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * The reputation graph, rendered: every score is recomputed from the evidence
 * the panel can show you — click a row for the five components and the raw
 * counts behind them. Vendor scores marked "→ engine" are live in policy
 * (vendorReputationLt); wallets marked "barred" are turned away by the gate.
 */
export function ReputationPanel({ graph }: { graph: GraphView | null }) {
  const [open, setOpen] = useState<string | null>(null);
  const g = graph;

  const rows = (list: ReputationRow[]) =>
    list.map((r) => {
      const key = `${r.kind}:${r.id}`;
      return <Row key={key} r={r} g={g!} open={open === key} onToggle={() => setOpen(open === key ? null : key)} />;
    });

  // The agents scoreboard grows with every scenario run — cap it. Barred rows
  // stay visible past the cap: enforcement is the point of this panel.
  const agents = g?.agents ?? [];
  const shownAgents = agents.filter((r, i) => i < MAX_AGENT_ROWS || r.barred);
  const moreAgents = agents.length - shownAgents.length;

  return (
    <section className="panel" style={{ flex: '0 0 auto' }}>
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Reputation</span>
        <span className="panel-count">
          {g?.subjects ?? 0} subjects · {g?.syncedCount ?? 0} → engine
        </span>
      </div>
      <div className="panel-body" style={{ maxHeight: '34vh' }}>
        {g && g.vendors.length > 0 && (
          <div className="gate-section">
            <div className="gate-section-title">Vendors</div>
            {rows(g.vendors)}
          </div>
        )}
        {g && shownAgents.length > 0 && (
          <div className="gate-section">
            <div className="gate-section-title">Payers &amp; agents</div>
            {rows(shownAgents)}
            {moreAgents > 0 && <div className="gate-more">+{moreAgents} more</div>}
          </div>
        )}
        {(!g || g.subjects === 0) && <div className="empty">No reputation evidence yet.</div>}
        {g && (
          <div className="rep-floor">
            enforced only when confident · deny &lt; {g.denyBelow} · conf ≥ {g.minConfidence}
          </div>
        )}
      </div>
    </section>
  );
}
