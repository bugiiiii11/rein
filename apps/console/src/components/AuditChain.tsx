import type { FeedItem } from '../../server/wire';
import { midHash } from '../format';

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
  publicKey: string;
  chainLinks: number;
}

export function AuditChain({ feed, publicKey, chainLinks }: Props) {
  const decisions = feed.filter((f) => f.kind === 'decision' && f.hash);

  // Verify the local hash chain: each link's prevHash must equal the prior hash.
  let intact = true;
  for (let i = 1; i < decisions.length; i++) {
    const prev = decisions[i - 1];
    const cur = decisions[i];
    if (prev && cur && cur.prevHash !== prev.hash) {
      intact = false;
      break;
    }
  }

  const recent = decisions.slice(-7).reverse();

  return (
    <section className="panel grow">
      <div className="panel-head">
        <span className="panel-tick" />
        <span className="panel-title">Audit Chain</span>
        <span className="panel-count">{chainLinks} links</span>
      </div>
      <div className="panel-body">
        <div className="chain-status">
          <span className="check">{intact ? '✓' : '!'}</span>
          <span className="chain-status-text">
            <b>{intact ? 'Chain intact' : 'Chain broken'}</b>
            <small>ed25519-signed · sha256-linked · tamper-evident</small>
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
