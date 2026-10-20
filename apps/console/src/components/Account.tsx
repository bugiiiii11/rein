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
              Your org<span className="pill-detail"> <b className="org-id">{me.org.orgId}</b></span>
            </>
          ) : (
            <>
              Public demo<span className="pill-detail"> · <b>no org claimed</b></span>
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
  const wallet = hasWallet();
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
        disabled={props.busy || !wallet}
        title={wallet ? undefined : 'No browser wallet found'}
        onClick={props.onEthereum}
      >
        {props.busy ? 'Waiting for your wallet…' : 'Sign in with Ethereum'}
      </button>
      {/* Said out loud, not only in the tooltip: a tester sat in front of a
          grey button with no idea why (S106). A claim link opened by the CLI
          lands in the DEFAULT browser, which is often not the wallet one. */}
      {!wallet && (
        <p className="signin-note signin-nowallet">
          No wallet in this browser, so Ethereum sign-in is off. Copy this page's address into a browser
          with MetaMask or another wallet extension{props.github ? ', or continue with GitHub' : ''}.
        </p>
      )}
      <p className="signin-note">No password, no custody. The wallet signature moves no funds.</p>
      {/* The identity is collected HERE, before the claim page's checkbox, so
          the notice has to be here too (soft-open legal scan E2). */}
      <p className="signin-note signin-legal">
        By signing in you agree to the{' '}
        <a href="https://reinconsole.com/terms" target="_blank" rel="noreferrer">Terms</a> and acknowledge the{' '}
        <a href="https://reinconsole.com/privacy" target="_blank" rel="noreferrer">Privacy Policy</a>.
      </p>
      {props.error && <p className="signin-err">{props.error}</p>}
    </div>
  );
}
