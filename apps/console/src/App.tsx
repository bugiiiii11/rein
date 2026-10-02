import { useEffect, useMemo, useState } from 'react';
import { useConsole } from './useConsole';
import { fetchMe, type Me } from './account';
import { chainStatus } from './chain';
import { TopBar } from './components/TopBar';
import { Kpis } from './components/Kpis';
import { Agents } from './components/Agents';
import { Policies } from './components/Policies';
import { Feed } from './components/Feed';
import { GatePanel } from './components/GatePanel';
import { SignerPanel } from './components/SignerPanel';
import { ReputationPanel } from './components/ReputationPanel';
import { BreakersPanel } from './components/BreakersPanel';
import { Escalations } from './components/Escalations';
import { Reconciliation } from './components/Reconciliation';
import { AuditChain } from './components/AuditChain';
import { Skeleton } from './components/Skeleton';

export function App() {
  const d = useConsole();
  const [me, setMe] = useState<Me>({ signIn: null });
  useEffect(() => {
    void fetchMe().then(setMe);
  }, []);
  // One verdict for the bar and the panel: they must never disagree.
  const chain = useMemo(() => chainStatus(d.feed, d.stats?.chainVerified), [d.feed, d.stats?.chainVerified]);

  if (!d.ready) {
    if (d.error) {
      return (
        <div className="boot">
          <span className="err">connection failed · {d.error}</span>
        </div>
      );
    }
    return <Skeleton me={me} />;
  }

  return (
    <div className="app">
      <TopBar connected={d.connected} demo={d.demo} stats={d.stats} chain={chain} writable={d.control.writable} me={me} />
      <Kpis stats={d.stats} />
      <main className="grid">
        <div className="col left">
          <Agents agents={d.agents} writable={d.control.writable} />
          <Policies policies={d.policies} />
          {/* Next to the policies that declare them. The row is one line
              precisely because this column has no spare height: every pixel
              here comes out of the agent list above it. */}
          <BreakersPanel breakers={d.breakers} />
          <ReputationPanel graph={d.graph} />
        </div>
        <div className="col">
          {/* Above the feed, and in THIS column, for a measured reason: the
              side columns are already at or under their content (adding it to
              the left took the agent list from 117px to 20px), while the feed
              is a long scroll list that gives up 80px for the cost of about
              four rows. A payment waiting on a human also belongs beside the
              live activity it interrupted, not below a scoreboard. */}
          <Escalations escalations={d.escalations} />
          <Feed feed={d.feed} />
        </div>
        <div className="col right">
          <GatePanel gate={d.gate} />
          <SignerPanel signer={d.signer} />
          <Reconciliation reconciliation={d.reconciliation} feed={d.feed} />
          <AuditChain feed={d.feed} chain={chain} publicKey={d.publicKey} chainLinks={d.stats?.chainLinks ?? 0} />
        </div>
      </main>
    </div>
  );
}
