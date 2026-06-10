import type { AgentView } from '../../server/wire';
import { api } from '../api';
import { usd } from '../format';

function shortAddr(a: string): string {
  if (a.length <= 12) return a;
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

function AgentCard({ a }: { a: AgentView }) {
  const frozen = a.status === 'frozen';
  const toggle = () => void (frozen ? api.unfreeze(a.id) : api.freeze(a.id));
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

      <div className="agent-actions">
        <button className="killswitch" onClick={toggle} title="Kill switch — freeze or release this agent">
          <span className={`switch ${frozen ? 'off' : 'on'}`} />
          {frozen ? 'Frozen' : 'Live'}
        </button>
        <button className="mini-btn" onClick={() => void api.ping(a.id)} title="Fire one guarded $0.01 call">
          Ping
        </button>
      </div>
    </div>
  );
}

export function Agents({ agents }: { agents: AgentView[] }) {
  const ordered = [...agents].reverse();
  return (
    <section className="panel grow">
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Agents</span>
        <span className="panel-count">{agents.length} managed</span>
      </div>
      <div className="panel-body">
        {ordered.length === 0 ? (
          <div className="empty">No agents yet — run a scenario.</div>
        ) : (
          ordered.map((a) => <AgentCard key={a.id} a={a} />)
        )}
      </div>
    </section>
  );
}
