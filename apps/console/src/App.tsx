import { useConsole } from './useConsole';
import { TopBar } from './components/TopBar';
import { Kpis } from './components/Kpis';
import { Agents } from './components/Agents';
import { Policies } from './components/Policies';
import { Feed } from './components/Feed';
import { GatePanel } from './components/GatePanel';
import { ReputationPanel } from './components/ReputationPanel';
import { Shadow } from './components/Shadow';
import { AuditChain } from './components/AuditChain';

export function App() {
  const d = useConsole();

  if (!d.ready) {
    return (
      <div className="boot">
        {d.error ? <span className="err">connection failed · {d.error}</span> : 'initializing control plane…'}
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar connected={d.connected} demo={d.demo} stats={d.stats} />
      <Kpis stats={d.stats} />
      <main className="grid">
        <div className="col left">
          <Agents agents={d.agents} />
          <Policies policies={d.policies} />
          <ReputationPanel graph={d.graph} />
        </div>
        <div className="col">
          <Feed feed={d.feed} />
        </div>
        <div className="col right">
          <GatePanel gate={d.gate} />
          <Shadow feed={d.feed} />
          <AuditChain feed={d.feed} publicKey={d.publicKey} chainLinks={d.stats?.chainLinks ?? 0} />
        </div>
      </main>
    </div>
  );
}
