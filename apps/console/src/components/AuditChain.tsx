import type { FeedItem } from '../../server/wire';
import type { ChainStatus, ChainVerdict } from '../chain';
import { clockTime, midHash } from '../format';

/** A short fingerprint of the engine's ed25519 public key (PEM). */
function fingerprint(pem: string): string {
  const body = pem
    .replace(/-----[^-]+-----/g, '')
    .replace(/\s+/g, '');
  if (!body) return 'ed25519';
  return `ed25519 · ${body.slice(0, 8)}…${body.slice(-6)}`;
}

interface Props {
  feed: FeedItem[];
  /** Computed once in App from the same feed, shared with the top bar. */
  chain: ChainStatus;
  publicKey: string;
  chainLinks: number;
}

const GLYPH: Record<ChainVerdict, string> = { intact: '✓', partial: '~', broken: '!', empty: '·' };
const HEAD: Record<ChainVerdict, string> = {
  intact: 'Chain intact',
  partial: 'Partial view',
  broken: 'Chain broken',
  empty: 'Nothing to verify yet',
};

function detail(c: ChainStatus): string {
  switch (c.verdict) {
    case 'intact':
      if (c.engine?.intact) {
        const outside = c.unseen > 0 ? ` · ${c.unseen} lead outside this org's view` : '';
        return `${c.visible} visible · whole chain verified by the engine ${clockTime(c.engine.at)}${outside}`;
      }
      return `${c.visible} visible · every link verified · ed25519-signed · sha256-linked`;
    case 'partial':
      return `${c.visible} visible · ${c.verified} links verified · ${c.unseen} lead outside this org's view`;
    case 'broken':
      if (c.engine?.intact === false) {
        return `the engine reports its own chain broken ${clockTime(c.engine.at)}`;
      }
      return 'a link points past rows this console can see: a fork, not a gap';
    default:
      return 'ed25519-signed · sha256-linked · tamper-evident';
  }
}

export function AuditChain({ feed, chain, publicKey, chainLinks }: Props) {
  const decisions = feed.filter((f) => f.kind === 'decision' && f.hash);
  const recent = decisions.slice(-7).reverse();

  return (
    <section className="panel grow">
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Audit Chain</span>
        <span className="panel-count">{chainLinks} links</span>
      </div>
      <div className="panel-body">
        <div className={`chain-status is-${chain.verdict}`}>
          <span className="check">{GLYPH[chain.verdict]}</span>
          <span className="chain-status-text">
            <b>{HEAD[chain.verdict]}</b>
            <small>{detail(chain)}</small>
          </span>
        </div>

        {recent.length === 0 ? (
          <div className="empty">No decisions recorded yet.</div>
        ) : (
          recent.map((d, idx) => (
            <div className="link" key={d.seq}>
              <div className="link-rail">
                <span className={`link-node ${d.outcome ?? ''}`} />
                {idx < recent.length - 1 && <span className="link-wire" />}
              </div>
              <div className="link-body">
                <div className="link-row">
                  <span className={`link-out ${d.outcome ?? ''}`}>{d.outcome}</span>
                  <span className="link-hash">{midHash(d.hash, 10, 6)}</span>
                </div>
                <div className="link-prev">
                  <span className="arrow">↳</span> prev {midHash(d.prevHash, 8, 6)}
                  {d.hash && chain.gaps.has(d.hash) && <span className="link-gap">outside view</span>}
                </div>
              </div>
            </div>
          ))
        )}

        <div className="chain-key">
          signing key <b>{fingerprint(publicKey)}</b>
        </div>
      </div>
    </section>
  );
}
