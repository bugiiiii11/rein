/**
 * The console's account routes (Sprint 13): sign-in, sign-out, "who am I",
 * and redeeming a claim code. Mounted ahead of the dashboard API, and outside
 * its read-only gate on purpose: signing in changes nothing on the engine, and
 * the one route that does -- the claim -- is the engine's decision, made
 * against a code only the sandbox's own key could have minted.
 *
 * Every POST must come from the console's own origin (`sameOrigin`): the
 * session cookie is SameSite=Lax, and the origin check is what keeps another
 * site from driving a signed-in browser into claiming an org it chose.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SignInError, safeReturnTo, type SignIn } from './signin';
import { EngineRefusal, type OwnerBridge } from './owners';

const MAX_BODY_BYTES = 8_192;

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new SignInError(413, 'too_large', 'request body too large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return {};
  try {
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new SignInError(400, 'bad_json', 'body must be a JSON object');
}

function fail(res: ServerResponse, err: unknown): void {
  if (err instanceof SignInError || err instanceof EngineRefusal) {
    sendJson(res, err.status, { error: err.code, message: err.message });
    return;
  }
  console.error('[rein] account route failed:', err);
  sendJson(res, 502, { error: 'engine_unreachable', message: 'the engine did not answer; try again shortly' });
}

/**
 * `signIn` undefined = sign-in is off on this deployment: `/api/me` says so
 * and every other account route 404s.
 */
export function createAccountHandler(signIn: SignIn | undefined, bridge: OwnerBridge | undefined) {
  return function handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method ?? 'GET';
    const ours =
      pathname === '/api/me' || pathname === '/api/claim' || pathname.startsWith('/api/auth/');
    if (!ours) return false;

    if (method === 'GET' && pathname === '/api/me') {
      if (!signIn || !bridge) {
        sendJson(res, 200, { signIn: null });
        return true;
      }
      const methods = { github: signIn.githubEnabled, ethereum: true };
      const session = signIn.session(req);
      if (!session) {
        sendJson(res, 200, { signIn: methods, user: null });
        return true;
      }
      bridge
        .viewFor(session.sub)
        .then((view) =>
          sendJson(res, 200, {
            signIn: methods,
            user: { name: session.name, identity: session.sub },
            org: view ? { orgId: view.orgId } : null,
          }),
        )
        .catch((err: unknown) => fail(res, err));
      return true;
    }

    if (!signIn || !bridge) {
      sendJson(res, 404, { error: 'signin_disabled', message: 'sign-in is not configured on this console' });
      return true;
    }

    if (method === 'GET' && pathname === '/api/auth/github/start') {
      try {
        signIn.githubStart(res, safeReturnTo(url.searchParams.get('returnTo')));
      } catch (err) {
        fail(res, err);
      }
      return true;
    }

    if (method === 'GET' && pathname === '/api/auth/github/callback') {
      signIn
        .githubCallback(req, res, url)
        .then((to) => {
          res.writeHead(302, { Location: to, 'Cache-Control': 'no-store' });
          res.end();
        })
        .catch((err: unknown) => {
          // A browser landed here, not a script: send it somewhere readable.
          const code = err instanceof SignInError ? err.code : 'oauth_failed';
          if (!(err instanceof SignInError)) console.error('[rein] GitHub sign-in failed:', err);
          res.writeHead(302, { Location: `/?signin_error=${encodeURIComponent(code)}`, 'Cache-Control': 'no-store' });
          res.end();
        });
      return true;
    }

    if (method !== 'POST') {
      sendJson(res, 404, { error: 'not_found', path: pathname });
      return true;
    }
    if (!signIn.sameOrigin(req)) {
      sendJson(res, 403, { error: 'cross_origin', message: 'account requests must come from this console' });
      return true;
    }

    if (pathname === '/api/auth/signout') {
      signIn.signOut(res);
      sendJson(res, 200, { ok: true });
      return true;
    }

    readJson(req)
      .then(async (body) => {
        if (pathname === '/api/auth/siwe/challenge') {
          sendJson(res, 200, signIn.siweChallenge(body['address']));
          return;
        }
        if (pathname === '/api/auth/siwe/verify') {
          const session = await signIn.siweVerify(res, body['nonce'], body['signature']);
          sendJson(res, 200, { user: { name: session.name, identity: session.sub } });
          return;
        }
        if (pathname === '/api/claim') {
          const session = signIn.session(req);
          if (!session) throw new SignInError(401, 'signin_required', 'sign in first, then claim');
          const code = body['code'];
          if (typeof code !== 'string' || code.length === 0 || code.length > 200) {
            throw new SignInError(400, 'bad_code', 'a claim code is required');
          }
          sendJson(res, 200, await bridge.redeem(code, session.sub));
          return;
        }
        sendJson(res, 404, { error: 'not_found', path: pathname });
      })
      .catch((err: unknown) => fail(res, err));
    return true;
  };
}
