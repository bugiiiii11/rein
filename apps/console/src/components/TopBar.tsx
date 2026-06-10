import type { DemoStatus, Stats } from '../../server/wire';
import { api } from '../api';
import { Logo } from './Logo';

interface Props {
  connected: boolean;
  demo: DemoStatus;
  stats: Stats | null;
}

export function TopBar({ connected, demo, stats }: Props) {
  const running = demo.running;
  return (
    <header className="cmd-bar">
      <div className="brand">
        <Logo />
        <span className="brand-name">REIN</span>
        <span className="brand-tag">CONSOLE</span>
      </div>

      <div className="cmd-spacer" />

      <div className="cmd-meta">
        <span className={`pill ${connected ? 'is-ok' : 'is-bad'}`}>
          <span className={`dot ${connected ? 'live' : 'off'}`} />
          {connected ? 'Live' : 'Reconnecting'}
        </span>
        <span className="pill">
          Audit chain <b>✓&nbsp;{stats?.chainLinks ?? 0}</b>
        </span>
      </div>

      <button className="run-btn" disabled={running} onClick={() => void api.runDemo()}>
        {running ? (
          <>
            <span className="spin" /> {demo.phase}
          </>
        ) : (
          <>▸ Run scenario</>
        )}
      </button>
    </header>
  );
}
