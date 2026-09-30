/**
 * Sign-in for the hosted console (Stage 4, Sprint 13.1): GitHub OAuth and
 * Sign-In with Ethereum, ending in one session cookie.
 *
 * What this is NOT: an authorization layer. A session says who somebody is;
 * what they may see is decided by the engine, which hands the console a
 * short-lived read key for the one org that identity owns (claims.ts on the
 * engine side). No Supabase Auth, no wallet custody, no password.
 *
 * The session is a stateless HMAC-signed cookie -- identity, display name,
 * expiry -- so a console restart does not sign anybody out and there is no
 * session table to keep. HttpOnly + Secure + SameSite=Lax, and every POST
 * that acts on it must come from the console's own origin (see
 * `sameOrigin`), which is the CSRF defence a JSON API needs on top of Lax.
 *
 * SIWE is EOA-only: `verifyMessage` recovers the signer, no RPC. The founder's
 * decision was desktop extension wallets without WalletConnect; a smart-
 * contract wallet (ERC-1271) would need a chain client here and is refused
 * with a clear reason rather than half-supported.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getAddress, verifyMessage } from 'viem';
import { createSiweMessage, generateSiweNonce } from 'viem/siwe';

export interface Session {
  /** `github:<numeric id>` or `eth:<lowercase address>` -- the engine's identity format. */
  sub: string;
  /** What the top bar shows: the GitHub login, or a shortened address. */
  name: string;
  /** Unix ms. */
  exp: number;
}

export interface SignInConfig {
  /** HMAC key for the session cookie, at least 32 characters. */
  sessionSecret: string;
  /** The console's public origin, e.g. `https://app.reinconsole.com` -- OAuth callback and SIWE domain. */
  publicUrl: string;
  github?: { clientId: string; clientSecret: string };
  sessionTtlMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export const SESSION_COOKIE = 'rein_session';
const STATE_COOKIE = 'rein_oauth';
const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_PENDING_CHALLENGES = 10_000;
/** Base mainnet: the chain id a SIWE message names. Sign-in moves no funds on any chain. */
const SIWE_CHAIN_ID = 8453;

export class SignInError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Sign-in settings from the environment; undefined when sign-in is off. */
export function signInFromEnv(env: NodeJS.ProcessEnv): SignInConfig | undefined {
  const sessionSecret = env['REIN_CONSOLE_SESSION_SECRET']?.trim();
  const publicUrl = env['REIN_CONSOLE_PUBLIC_URL']?.trim();
  if (!sessionSecret && !publicUrl) return undefined;
  if (!sessionSecret || sessionSecret.length < 32) {
    throw new Error('REIN_CONSOLE_SESSION_SECRET must be set to at least 32 characters when sign-in is on');
  }
  if (!publicUrl || !/^https?:\/\/[^/]+$/.test(publicUrl)) {
    throw new Error('REIN_CONSOLE_PUBLIC_URL must be an origin like https://app.reinconsole.com (no path)');
  }
  const clientId = env['REIN_GITHUB_CLIENT_ID']?.trim();
  const clientSecret = env['REIN_GITHUB_CLIENT_SECRET']?.trim();
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error('set BOTH REIN_GITHUB_CLIENT_ID and REIN_GITHUB_CLIENT_SECRET, or neither');
  }
  return {
    sessionSecret,
    publicUrl,
    ...(clientId && clientSecret ? { github: { clientId, clientSecret } } : {}),
  };
}

// --- cookies ---------------------------------------------------------------

export function readCookie(req: IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function cookie(name: string, value: string, opts: { maxAgeSec: number; secure: boolean; path?: string }): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    `Path=${opts.path ?? '/'}`,
    `Max-Age=${opts.maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(opts.secure ? ['Secure'] : []),
  ].join('; ');
}

function appendCookie(res: ServerResponse, value: string): void {
  const prev = res.getHeader('Set-Cookie');
  const list = prev === undefined ? [] : Array.isArray(prev) ? prev.map(String) : [String(prev)];
  res.setHeader('Set-Cookie', [...list, value]);
}

// --- signed tokens -----------------------------------------------------------

function sign(secret: string, payload: object): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function unsign<T>(secret: string, token: string | undefined): T | undefined {
  if (!token) return undefined;
  const dot = token.lastIndexOf('.');
  if (dot < 1) return undefined;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = createHmac('sha256', secret).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return undefined;
  try {
    return JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Only a same-site path may be a post-sign-in destination -- never an open redirect. */
export function safeReturnTo(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return '/';
  return raw.length > 512 ? '/' : raw;
}

export interface SignIn {
  readonly githubEnabled: boolean;
  /** The verified session on this request, if any. */
  session(req: IncomingMessage): Session | undefined;
  /** Refuse a state-changing request from any other origin. */
  sameOrigin(req: IncomingMessage): boolean;
  signOut(res: ServerResponse): void;
  /** 302 to GitHub; `returnTo` rides in a signed, short-lived state cookie. */
  githubStart(res: ServerResponse, returnTo: string): void;
  /** Handle GitHub's redirect back. Resolves to where to send the browser. */
  githubCallback(req: IncomingMessage, res: ServerResponse, url: URL): Promise<string>;
  /** The EIP-4361 message for this address to sign, with a server-held nonce. */
  siweChallenge(address: unknown): { message: string; nonce: string };
  siweVerify(res: ServerResponse, nonce: unknown, signature: unknown): Promise<Session>;
}

export function createSignIn(config: SignInConfig): SignIn {
  const now = config.now ?? Date.now;
  const doFetch = config.fetchImpl ?? fetch;
  const ttl = config.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  const origin = new URL(config.publicUrl);
  const secure = origin.protocol === 'https:';
  const callbackUrl = `${config.publicUrl}/api/auth/github/callback`;
  /** nonce -> the exact message issued and when it dies. One use each. */
  const challenges = new Map<string, { message: string; address: `0x${string}`; exp: number }>();

  function startSession(res: ServerResponse, sub: string, name: string): Session {
    const session: Session = { sub, name, exp: now() + ttl };
    appendCookie(res, cookie(SESSION_COOKIE, sign(config.sessionSecret, session), { maxAgeSec: Math.floor(ttl / 1000), secure }));
    return session;
  }

  function sweep(): void {
    const t = now();
    for (const [nonce, c] of challenges) if (c.exp <= t) challenges.delete(nonce);
  }

  return {
    githubEnabled: config.github !== undefined,

    session(req) {
      const s = unsign<Session>(config.sessionSecret, readCookie(req, SESSION_COOKIE));
      if (!s || typeof s.sub !== 'string' || typeof s.exp !== 'number' || s.exp <= now()) return undefined;
      return s;
    },

    sameOrigin(req) {
      const seen = req.headers.origin ?? req.headers.referer;
      if (typeof seen !== 'string') return false;
      try {
        return new URL(seen).origin === origin.origin;
      } catch {
        return false;
      }
    },

    signOut(res) {
      appendCookie(res, cookie(SESSION_COOKIE, '', { maxAgeSec: 0, secure }));
    },

    githubStart(res, returnTo) {
      if (!config.github) throw new SignInError(404, 'github_disabled', 'GitHub sign-in is not configured here');
      const state = randomBytes(16).toString('base64url');
      appendCookie(
        res,
        cookie(STATE_COOKIE, sign(config.sessionSecret, { state, returnTo: safeReturnTo(returnTo), exp: now() + 600_000 }), {
          maxAgeSec: 600,
          secure,
          path: '/api/auth/github',
        }),
      );
      const url = new URL('https://github.com/login/oauth/authorize');
      url.searchParams.set('client_id', config.github.clientId);
      url.searchParams.set('redirect_uri', callbackUrl);
      url.searchParams.set('state', state);
      // No scope: the public profile is all an identity needs. Rein never
      // asks GitHub for repos, email or anything it would have to protect.
      url.searchParams.set('allow_signup', 'true');
      res.writeHead(302, { Location: url.toString(), 'Cache-Control': 'no-store' });
      res.end();
    },

    async githubCallback(req, res, url) {
      if (!config.github) throw new SignInError(404, 'github_disabled', 'GitHub sign-in is not configured here');
      const saved = unsign<{ state: string; returnTo: string; exp: number }>(config.sessionSecret, readCookie(req, STATE_COOKIE));
      appendCookie(res, cookie(STATE_COOKIE, '', { maxAgeSec: 0, secure, path: '/api/auth/github' }));
      const state = url.searchParams.get('state');
      const code = url.searchParams.get('code');
      if (!saved || saved.exp <= now() || !state || state !== saved.state) {
        throw new SignInError(400, 'oauth_state', 'the sign-in link expired or was opened in another browser; try again');
      }
      if (!code) throw new SignInError(400, 'oauth_denied', url.searchParams.get('error_description') ?? 'GitHub sign-in was cancelled');

      const tokenRes = await doFetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: config.github.clientId,
          client_secret: config.github.clientSecret,
          code,
          redirect_uri: callbackUrl,
        }),
      });
      const token = (await tokenRes.json().catch(() => ({}))) as { access_token?: string; error?: string };
      if (!token.access_token) throw new SignInError(502, 'oauth_exchange', `GitHub refused the code: ${token.error ?? tokenRes.status}`);

      const userRes = await doFetch('https://api.github.com/user', {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'rein-console' },
      });
      const user = (await userRes.json().catch(() => ({}))) as { id?: unknown; login?: unknown };
      if (typeof user.id !== 'number' || typeof user.login !== 'string') {
        throw new SignInError(502, 'oauth_profile', `GitHub did not return a profile (HTTP ${userRes.status})`);
      }
      // The access token is dropped here: the identity is all Rein keeps.
      startSession(res, `github:${user.id}`, user.login);
      return saved.returnTo;
    },

    siweChallenge(address) {
      if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
        throw new SignInError(400, 'bad_address', 'address must be a 0x-prefixed 20-byte hex string');
      }
      sweep();
      if (challenges.size >= MAX_PENDING_CHALLENGES) {
        throw new SignInError(503, 'busy', 'too many sign-ins in flight; try again in a minute');
      }
      const checksummed = getAddress(address);
      const nonce = generateSiweNonce();
      const issuedAt = new Date(now());
      const message = createSiweMessage({
        domain: origin.host,
        address: checksummed,
        statement: 'Sign in to Rein. This signature proves you hold this address; it moves no funds and costs no gas.',
        uri: config.publicUrl,
        version: '1',
        chainId: SIWE_CHAIN_ID,
        nonce,
        issuedAt,
        expirationTime: new Date(issuedAt.getTime() + CHALLENGE_TTL_MS),
      });
      challenges.set(nonce, { message, address: checksummed, exp: issuedAt.getTime() + CHALLENGE_TTL_MS });
      return { message, nonce };
    },

    async siweVerify(res, nonce, signature) {
      if (typeof nonce !== 'string' || typeof signature !== 'string' || !/^0x[0-9a-fA-F]+$/.test(signature)) {
        throw new SignInError(400, 'bad_request', 'nonce and a 0x signature are required');
      }
      const challenge = challenges.get(nonce);
      // Spent on first sight, verified or not: a nonce is one attempt.
      challenges.delete(nonce);
      if (!challenge || challenge.exp <= now()) {
        throw new SignInError(400, 'siwe_expired', 'the sign-in message expired; start again');
      }
      let valid = false;
      try {
        valid = await verifyMessage({
          address: challenge.address,
          message: challenge.message,
          signature: signature as `0x${string}`,
        });
      } catch {
        valid = false;
      }
      if (!valid) {
        throw new SignInError(
          401,
          'siwe_invalid',
          'the signature does not match the address (smart-contract wallets are not supported yet; use an extension wallet account)',
        );
      }
      const lower = challenge.address.toLowerCase();
      return startSession(res, `eth:${lower}`, `${challenge.address.slice(0, 6)}...${challenge.address.slice(-4)}`);
    },
  };
}
