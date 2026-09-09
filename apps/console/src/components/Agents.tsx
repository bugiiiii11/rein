import type { AgentLivenessView, AgentView } from '../../server/wire';
import { api } from '../api';
import { duration, usd } from '../format';

function shortAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

/**
 * The dead-man chip (B2), rendered ON the agent it describes.
 *
 * An agent with no chip is one nobody watches — absence means unwatched, not
 * healthy, because an expectation is declared rather than inferred. `unknown`
 * gets its own wording for the same reason it gets its own state: the console
 * restarted and cannot vouch for the silence it can see, and dressing that up
 * as an alarm would be a claim it has no evidence for.
 */
function LivenessChip({ live }: { live: AgentLivenessView }) {
  const seen = live.lastSeenAt
    ? `last seen ${new Date(live.lastSeenAt).toLocaleTimeString('en-GB', { hour12: false })} (${live.lastSource ?? 'seen'})`
    : 'never seen since watching began';
  const title = [
    live.note ?? 'expected to be active on a schedule',
    `expects activity every ${live.interval}`,
    seen,
    live.status === 'unknown'
      ? 'the console restarted more recently than this silence — not an alarm'
      : live.status === 'missing'
        ? 'nothing was blocked: this is work that is NOT happening'
        : '',
  ]
    .filter(Boolean)
    .join(' · ');
  const text =
    live.status === 'alive'
      ? `live · every ${live.interval}`
      : live.status === 'unknown'
        ? `silent ${duration(live.silentMs)} · unwitnessed`
        : `silent ${duration(live.silentMs)}`;
  return (
    <span className={`tag liveness ${live.status}`} title={title}>
      {text}
    </span>
  );
}

function AgentCard({ a, writable }: { a: AgentView; writable: boolean }) {
  const frozen = a.status === 'frozen';
  const toggle = () => void (frozen ? api.unfreeze(a.id) : api.freeze(a.id));
  const withheld = writable ? undefined : 'read-only console — controls are withheld';
  return (
    <div className={`agent ${frozen ? 'frozen' : ''}`}>
      <div className="agent-top">
        <span className="agent-name">{a.name}</span>
        <span className={`status-tag ${a.status}`}>{a.status}</span>
      </div>

      <div className="agent-meta">
        <span className={`tag mode-${a.mode}`}>{a.mode}</span>
        <span className="tag">{a.chain}</span>
        <span className="tag">{shortAddr(a.address)}</span>
        {a.labels.map((l) => (
          <span className="tag label" key={l} title="Semantic label — policies can target it">
            #{l}
          </span>
        ))}
        {a.liveness && <LivenessChip live={a.liveness} />}
      </div>

      <div className="agent-figures">
        <div>
          <div className="figure-label">spent</div>
          <div className="figure-value">{usd(a.spent)}</div>
        </div>
        <div>
          <div className="figure-label">calls</div>
          <div className="figure-value">{a.calls}</div>
        </div>
      </div>

      {/* The kill switch stays VISIBLE when read-only — its state (frozen or
          live) is information in its own right, and hiding it would hide that
          too. It just cannot be thrown. */}
      <div className="agent-actions">
        <button
          className="killswitch"
          onClick={toggle}
          disabled={!writable}
          title={withheld ?? 'Kill switch — freeze or release this agent'}
        >
          <span className={`switch ${frozen ? 'off' : 'on'}`} />
          {frozen ? 'Frozen' : 'Live'}
        </button>
        <button
          className="mini-btn"
          onClick={() => void api.ping(a.id)}
          disabled={!writable}
          title={withheld ?? 'Fire one guarded $0.01 call'}
        >
          Ping
        </button>
      </div>
    </div>
  );
}

export function Agents({ agents, writable }: { agents: AgentView[]; writable: boolean }) {
  const ordered = [...agents].reverse();
  // Only a real alarm is counted here. `late` is inside its grace and
  // `unknown` is about our own restart; neither is news, and a header that
  // counted them would cry at every deploy.
  const missing = agents.filter((a) => a.liveness?.status === 'missing').length;
  return (
    <section className="panel grow">
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Agents</span>
        <span className={`panel-count ${missing > 0 ? 'bad' : ''}`}>
          {agents.length} managed{missing > 0 ? ` · ${missing} silent` : ''}
        </span>
      </div>
      <div className="panel-body">
        {ordered.length === 0 ? (
          <div className="empty">No agents yet — run a scenario.</div>
        ) : (
          ordered.map((a) => <AgentCard key={a.id} a={a} writable={writable} />)
        )}
      </div>
    </section>
  );
}
