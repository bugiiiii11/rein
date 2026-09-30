import { useState } from 'react';
import { hasWallet, signInWithEthereum, signInWithGitHub, signOut, type Me } from '../account';

/**
 * Who is looking, and whose numbers these are. The second half matters more
 * than the first: a signed-in owner must never mistake the public demo for
 * their own org, so the pill always names what is on screen.
 */
export function Account({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!me.signIn) return null;

  const run = (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    fn()
      .then(() => window.location.reload())
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
        setBusy(false);
      });
  };

  if (me.user) {
    return (
      <div className="account">
        <span className={`pill ${me.org ? 'is-ok' : ''}`} title={me.user.identity}>
          {me.org ? (
            <>
              Your org <b>{me.org.orgId}</b>
            </>
          ) : (
            <>
              Public demo · <b>no org claimed</b>
            </>
          )}
        </span>
        <button className="pill account-btn" disabled={busy} onClick={() => run(signOut)} title={`Signed in as ${me.user.name}`}>
          {me.user.name} · Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="account">
      <span className="pill" title="Rein's own org, read-only. Sign in to see yours.">
        Public demo
      </span>
      <button className="pill account-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        Sign in
      </button>
      {open && (
        <SignInMenu
          github={me.signIn.github}
          busy={busy}
          error={error}
          returnTo={window.location.pathname + window.location.search}
          onEthereum={() => run(signInWithEthereum)}
        />
      )}
    </div>
  );
}

export function SignInMenu(props: {
  github: boolean;
  busy: boolean;
  error: string | null;
  returnTo: string;
  onEthereum: () => void;
}) {
  return (
    <div className="signin-menu" role="menu">
      {props.github && (
        <button className="signin-opt" role="menuitem" disabled={props.busy} onClick={() => signInWithGitHub(props.returnTo)}>
          Continue with GitHub
        </button>
      )}
      <button
        className="signin-opt"
        role="menuitem"
        disabled={props.busy || !hasWallet()}
        title={hasWallet() ? undefined : 'No browser wallet found'}
        onClick={props.onEthereum}
      >
        {props.busy ? 'Waiting for your wallet…' : 'Sign in with Ethereum'}
      </button>
      <p className="signin-note">No password, no custody. The wallet signature moves no funds.</p>
      {props.error && <p className="signin-err">{props.error}</p>}
    </div>
  );
}
