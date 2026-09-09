import type { DemoStatus, Stats } from '../../server/wire';
import { api } from '../api';
import { Logo } from './Logo';

interface Props {
  connected: boolean;
  demo: DemoStatus;
  stats: Stats | null;
  /** False on a public deployment with no API key — see resolveConsolePosture. */
  writable: boolean;
}

export function TopBar({ connected, demo, stats, writable }: Props) {
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
        {!writable && (
          <span
            className="pill is-ro"
            title="This console accepts no state changes: the controls are withheld, not broken. Set REIN_CONSOLE_API_KEY, or run it on 127.0.0.1, to enable them."
          >
            Read-only
          </span>
        )}
        <a className="pill" href="https://reinconsole.com/get-started.html" target="_blank" rel="noopener">
          Guide ↗
        </a>
      </div>

      {/* Disabled rather than hidden: a visible-but-inert control tells the
          viewer the capability exists and why it is withheld, where a missing
          one just looks like a console with less in it. */}
      <button
        className={`run-btn ${writable ? '' : 'is-ro'}`}
        disabled={running || !writable}
        title={writable ? undefined : 'read-only console — scenario runs are disabled'}
        onClick={() => void api.runDemo()}
      >
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
