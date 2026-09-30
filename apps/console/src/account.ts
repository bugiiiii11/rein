/**
 * The browser half of sign-in and claims (Sprint 13). The server does every
 * check; this only carries a signature or a redirect there. After any change
 * of identity the page reloads, so the dashboard stream reconnects as the
 * new session instead of mixing two orgs' events.
 */

export interface Me {
  /** null = sign-in is off on this console. */
  signIn: { github: boolean; ethereum: boolean } | null;
  user?: { name: string; identity: string } | null;
  org?: { orgId: string } | null;
}

export async function fetchMe(): Promise<Me> {
  try {
    const res = await fetch('/api/me');
    if (!res.ok) return { signIn: null };
    return (await res.json()) as Me;
  } catch {
    return { signIn: null };
  }
}

async function postJson<T>(path: string, body: object = {}): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(json['message'] ?? json['error'] ?? `HTTP ${res.status}`));
  return json as T;
}

export function signInWithGitHub(returnTo: string): void {
  window.location.href = `/api/auth/github/start?returnTo=${encodeURIComponent(returnTo)}`;
}

interface Eip1193 {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

export function hasWallet(): boolean {
  return typeof window !== 'undefined' && (window as unknown as { ethereum?: Eip1193 }).ethereum !== undefined;
}

/** EIP-4361 through the extension wallet: the server writes the message, the wallet signs it. */
export async function signInWithEthereum(): Promise<void> {
  const eth = (window as unknown as { ethereum?: Eip1193 }).ethereum;
  if (!eth) throw new Error('no browser wallet found -- install an extension wallet, or sign in with GitHub');
  const accounts = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  const address = accounts[0];
  if (!address) throw new Error('the wallet shared no account');
  const { message, nonce } = await postJson<{ message: string; nonce: string }>('/api/auth/siwe/challenge', { address });
  const signature = await eth.request({ method: 'personal_sign', params: [message, address] });
  await postJson('/api/auth/siwe/verify', { nonce, signature });
}

export async function signOut(): Promise<void> {
  await postJson('/api/auth/signout');
}

export function claim(code: string): Promise<{ orgId: string; alreadyOwned: boolean }> {
  return postJson('/api/claim', { code });
}
