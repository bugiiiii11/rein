import type { DemoStatus, Stats } from '../../server/wire';
import type { ChainStatus } from '../chain';
import { api } from '../api';
import { Logo } from './Logo';
import { Account } from './Account';
import type { Me } from '../account';

interface Props {
  connected: boolean;
  demo: DemoStatus;
  stats: Stats | null;
  /** The local chain verdict (src/chain.ts); null before the first snapshot. */
  chain: ChainStatus | null;
  /** False on a public deployment with no API key — see resolveConsolePosture. */
  writable: boolean;
  me: Me;
  /** Before the first snapshot: the bar is real, its claims are not yet. */
  booting?: boolean;
}

/**
 * The bar's chain pill used to print a check mark next to the link count no
 * matter what the panel below had found — the glyph was decoration. It now
 * says what the panel says, from the same verdict.
 */
function chainPill(chain: ChainStatus | null, booting: boolean, links: number) {
  if (booting) return { glyph: '·', tone: '', title: 'connecting', count: '—' };
  const count = String(links);
  if (!chain || chain.verdict === 'empty') return { glyph: '·', tone: '', title: 'no decisions yet', count };
  if (chain.verdict === 'broken') {
    return { glyph: '!', tone: 'is-bad', title: 'a visible link points past rows this console can see: a fork, not a gap', count };
  }
  if (chain.verdict === 'partial') {
    return {
      glyph: '~',
      tone: '',
      title: `${chain.verified} links verified here · ${chain.unseen} lead to rows outside this org's view`,
      count,
    };
  }
  return { glyph: '✓', tone: 'is-ok', title: `${chain.verified} links verified here`, count };
}

export function TopBar({ connected, demo, stats, chain, writable, me, booting = false }: Props) {
  const running = demo.running;
  const cp = chainPill(chain, booting, stats?.chainLinks ?? 0);
  return (
    <header className="cmd-bar">
      <div className="brand">
        <Logo />
        <span className="brand-name">REIN</span>
        <span className="brand-tag">CONSOLE</span>
      </div>

      <div className="cmd-spacer" />

      <div className="cmd-meta">
        <Account me={me} />
        <span className={`pill ${booting ? '' : connected ? 'is-ok' : 'is-bad'}`}>
          <span className={`dot ${booting ? '' : connected ? 'live' : 'off'}`} />
          {booting ? 'Connecting' : connected ? 'Live' : 'Reconnecting'}
        </span>
        <span className={`pill ${cp.tone}`} title={cp.title}>
          Audit chain <b>{cp.glyph}&nbsp;{cp.count}</b>
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
