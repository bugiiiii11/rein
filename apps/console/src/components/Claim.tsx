import { useEffect, useState } from 'react';
import { claim, fetchMe, signInWithEthereum, type Me } from '../account';
import { Logo } from './Logo';
import { SignInMenu } from './Account';

/**
 * `/claim?code=...` -- where `npx @reinconsole/init --claim` sends the
 * browser. Sign in, then one button keeps the sandbox: its keys stop
 * expiring and the dashboard shows it as yours.
 */
export function Claim() {
  const code = new URLSearchParams(window.location.search).get('code') ?? '';
  const [me, setMe] = useState<Me | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    void fetchMe().then(setMe);
  }, []);

  const doClaim = () => {
    setBusy(true);
    setError(null);
    claim(code)
      .then((r) => setDone(r.orgId))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  let body: JSX.Element;
  if (!code) {
    body = <p>This link has no claim code. Run <code>npx @reinconsole/init --claim</code> in the folder that holds your <code>rein-agent.json</code>.</p>;
  } else if (me === null) {
    body = <p>Loading…</p>;
  } else if (!me.signIn) {
    body = <p>Sign-in is not enabled on this console.</p>;
  } else if (done) {
    body = (
      <>
        <p className="claim-ok">Claimed. <b>{done}</b> is yours: its keys no longer expire and the sandbox quotas are lifted.</p>
        <a className="run-btn" href="/">Open your dashboard</a>
      </>
    );
  } else if (!me.user) {
    body = (
      <>
        <p>Sign in to keep this sandbox. Your account becomes its owner; one org per account.</p>
        <SignInMenu
          github={me.signIn.github}
          busy={busy}
          error={error}
          returnTo={`/claim?code=${encodeURIComponent(code)}`}
          onEthereum={() => {
            setBusy(true);
            signInWithEthereum()
              .then(() => window.location.reload())
              .catch((err: unknown) => {
                setError(err instanceof Error ? err.message : String(err));
                setBusy(false);
              });
          }}
        />
      </>
    );
  } else if (me.org) {
    body = (
      <>
        <p>You already own <b>{me.org.orgId}</b>. One org per account: this link cannot add a second.</p>
        <a className="run-btn" href="/">Open your dashboard</a>
      </>
    );
  } else {
    body = (
      <>
        <p>
          Signed in as <b>{me.user.name}</b>. Claiming binds this sandbox to that account for good.
        </p>
        <button className="run-btn" disabled={busy} onClick={doClaim}>
          {busy ? 'Claiming…' : 'Claim this sandbox'}
        </button>
        {error && <p className="signin-err">{error}</p>}
      </>
    );
  }

  return (
    <div className="claim-page">
      <div className="claim-card">
        <div className="brand">
          <Logo />
          <span className="brand-name">REIN</span>
          <span className="brand-tag">CLAIM</span>
        </div>
        {body}
      </div>
    </div>
  );
}
