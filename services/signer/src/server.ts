import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  AgentId,
  Decision,
  DecimalString,
  PaymentIntent,
  type ApiKeyScope,
  type Session,
} from '@reinconsole/core';
import {
  AuthError,
  readCredential,
  secretsEqual,
  type ApiKeyAuth,
} from '@reinconsole/core/auth';
import { PaymentRequirement } from '@reinconsole/sdk';
import { SignerError } from './errors.js';
import { effectiveExpiry, sessionState } from './sessions.js';
import type { SessionSigner } from './signer.js';

/**
 * The ttl ceiling is built into the schema so an over-long request comes back
 * as a 400 naming the cap, rather than a 500 from the signer's own throw.
 */
function sessionInputSchema(maxLifetimeSeconds: number) {
  return z.object({
    agentId: AgentId,
    capAmount: DecimalString.optional(),
    maxPerPayment: DecimalString.optional(),
    ttlSeconds: z.number().int().positive().max(maxLifetimeSeconds).optional(),
  });
}

const SignInput = z.object({
  sessionToken: z.string().min(1),
  requirement: PaymentRequirement,
  intent: PaymentIntent,
  decision: Decision,
});

/**
 * What the API shows of a session: everything but the token hash, plus the
 * lifetime-capped expiry it will actually die at. `expiresAt` stays the stored
 * grant so the two never silently diverge in an operator's eyes.
 */
function redact(session: Session, spent: string, maxLifetimeSeconds: number) {
  const { tokenHash: _tokenHash, ...rest } = session;
  return {
    ...rest,
    spent,
    effectiveExpiresAt: effectiveExpiry(session, maxLifetimeSeconds),
  };
}

/**
 * The admin surface's shortest acceptable secret. These routes MINT spending
 * authority and the secret is presented over the network on every call, so it
 * has to be a secret rather than a password someone reaches on the third
 * guess. 32 hex chars of `randomBytes(16)` clears it comfortably.
 */
const MIN_ADMIN_TOKEN_LENGTH = 16;

export interface SignerServerOptions {
  /**
   * Bearer secret guarding the session-admin routes (create / list / revoke /
   * delete). Presented as `Authorization: Bearer <token>` or `X-Api-Key`.
   *
   * One static secret, all-or-nothing: it satisfies every route. It stays
   * supported beside {@link SignerServerOptions.auth} because it is what
   * deployments already carry in their environment, and an upgrade that
   * locked an operator out of their own signer would be a poor trade for
   * key rotation.
   */
  adminToken?: string;
  /**
   * D1(b): scoped, rotatable, revocable API keys instead of (or beside) the
   * one static token. Reads need `read`, anything that mints or kills a grant
   * needs `admin` — so a dashboard can list sessions with a key that could
   * never create one. Back it with a durable store (`PgApiKeyStore`) or a
   * revoked key returns from the dead on the next restart.
   */
  auth?: ApiKeyAuth;
  /**
   * The explicit, deliberate opt-out — the ONLY way to serve an unauthenticated
   * admin surface. Passing it is a statement; forgetting `adminToken` is not.
   */
  adminAuth?: 'off';
}

/** An admin request that carried no credential, or the wrong one. */
class AdminAuthError extends Error {
  constructor(
    readonly code: 'missing_credentials' | 'invalid_credentials',
    message: string,
  ) {
    super(message);
    this.name = 'AdminAuthError';
  }
}

/**
 * Build the signer HTTP API. Wallet keys are registered in-process on the
 * {@link SessionSigner} before serving — there is deliberately no endpoint
 * that accepts a private key.
 *
 * The session-admin routes REQUIRE a bearer secret. This is the custody tier:
 * `POST /v1/sessions` mints a grant with whatever cap it is asked for, against
 * a wallet this process holds the key to, so an open admin surface is a wallet
 * drain for anyone who can reach the port. Unlike the engine — which may run
 * keyless as long as it binds loopback — the signer is a library with no boot
 * path of its own to enforce a safe bind from, so the default cannot be "open,
 * and trust the deployer to have read the note". Omitting BOTH `adminToken`
 * and `adminAuth: 'off'` is a construction error, thrown here rather than
 * discovered in a log.
 *
 * Since D1(b) that credential can be a scoped API key ({@link
 * SignerServerOptions.auth}) rather than one static secret, which is what
 * buys rotation without a flag-day and a revocation that actually sticks.
 * Either satisfies the guard; the static token remains all-or-nothing while a
 * key holds `read` (list) or `admin` (mint / revoke / delete).
 *
 * `POST /v1/sign` is deliberately NOT behind it: the session token in the body
 * IS that route's credential — scoped, capped, expiring and revocable, which
 * is the whole point of the tier. `/health` stays open for probes.
 */
export function buildSignerServer(
  signer: SessionSigner,
  options: SignerServerOptions = {},
): FastifyInstance {
  const adminToken = options.adminToken?.trim();
  const auth = options.auth;
  const guarded = adminToken !== undefined || auth !== undefined;
  if (guarded && options.adminAuth === 'off') {
    throw new Error(
      'buildSignerServer: pass adminToken/auth OR adminAuth: "off", not both — which one governs is not for this function to guess',
    );
  }
  if (!guarded && options.adminAuth !== 'off') {
    throw new Error(
      'buildSignerServer: the session-admin routes mint spending authority against wallets this process holds.\n' +
        '  Pass { adminToken: <secret> } or { auth: <ApiKeyAuth> } to protect them, or\n' +
        '  pass { adminAuth: "off" } to serve them unauthenticated on purpose.',
    );
  }
  if (adminToken !== undefined && adminToken.length < MIN_ADMIN_TOKEN_LENGTH) {
    throw new Error(
      `buildSignerServer: adminToken must be at least ${MIN_ADMIN_TOKEN_LENGTH} characters`,
    );
  }

  const app = Fastify({ logger: false });
  const maxLifetime = signer.maxSessionLifetimeSeconds;
  const SessionInput = sessionInputSchema(maxLifetime);

  /**
   * The guard on every route that can mint, read, or kill a grant. It hangs
   * off `onRequest`, not `preHandler`, so an unauthenticated request is
   * refused BEFORE Fastify parses its body — an anonymous caller should not
   * be able to reach the JSON parser, and a bodyless probe should get the 401
   * it earned rather than a content-type complaint.
   */
  const requireScope =
    (scope: ApiKeyScope) =>
    (req: FastifyRequest, _reply: unknown, done: (err?: Error) => void) => {
      if (!guarded) return done();
      const presented = readCredential(req.headers);
      if (presented === undefined) {
        return done(
          new AdminAuthError(
            'missing_credentials',
            'missing admin token (Authorization: Bearer ...)',
          ),
        );
      }
      // The static token is checked FIRST and satisfies every scope: it is the
      // all-or-nothing credential, and a deployment still carrying it must not
      // start failing because a scoped key store was added beside it.
      if (adminToken !== undefined && secretsEqual(presented, adminToken)) return done();
      if (auth === undefined) {
        return done(new AdminAuthError('invalid_credentials', 'admin token is not valid'));
      }
      try {
        auth.authenticate(req.headers, scope);
      } catch (err) {
        // AuthError.is, never a bare instanceof: core is bundled into each
        // service (`noExternal`), so the class this throws is a DIFFERENT copy
        // from the one imported here and instanceof silently misses it — which
        // would turn a 401 into a 500.
        return done(err as Error);
      }
      return done();
    };

  const requireAdmin = requireScope('admin');
  const requireRead = requireScope('read');

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AdminAuthError) {
      // A challenge, never a silent 404: an operator holding the wrong secret
      // should learn that, not conclude the route moved.
      return reply
        .status(401)
        .header('www-authenticate', 'Bearer realm="rein-signer"')
        .send({ error: 'unauthorized', code: err.code, reason: err.message });
    }
    // An API key's refusal, rendered in the signer's envelope rather than the
    // engine's — one service, one error shape. 401 gets the same challenge as
    // above; 403 deliberately does not, because the caller IS known and
    // re-presenting the same key is not the answer.
    if (AuthError.is(err)) {
      if (err.status === 401) {
        return reply
          .status(401)
          .header('www-authenticate', 'Bearer realm="rein-signer"')
          .send({ error: 'unauthorized', code: err.code, reason: err.message });
      }
      return reply
        .status(err.status)
        .send({ error: 'forbidden', code: err.code, reason: err.message });
    }
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'validation_error', issues: err.issues });
    }
    if (err instanceof SignerError) {
      return reply.status(403).send({ error: 'refused', code: err.code, reason: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    // Fastify raises its own errors for a malformed request — an unparseable
    // or empty JSON body, an unsupported content-type — and they carry the
    // status they deserve. Reporting a caller's mistake as 500 sends an
    // operator hunting a bug in the signer.
    const status = (err as { statusCode?: number } | null)?.statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return reply.status(status).send({ error: 'bad_request', message });
    }
    return reply.status(500).send({ error: 'internal_error', message });
  });

  // Advertised so a client can tell "this signer wants a credential" apart
  // from "mine is wrong" without guessing from a 401 — and which KIND, since
  // a static token and an API key are presented identically.
  const adminAuthMode = !guarded
    ? 'off'
    : adminToken === undefined
      ? 'api-key'
      : auth === undefined
        ? 'bearer'
        : 'bearer+api-key';

  app.get('/health', () => ({
    status: 'ok',
    maxSessionLifetimeSeconds: maxLifetime,
    adminAuth: adminAuthMode,
  }));

  // --- Sessions ---
  // Writes are awaited: on a durable store, a 2xx means the grant (or the
  // revocation) is on disk, not merely in memory.
  app.post('/v1/sessions', { onRequest: requireAdmin }, async (req) => {
    const input = SessionInput.parse(req.body);
    const created = await signer.createSession(input);
    return { session: redact(created.session, '0', maxLifetime), token: created.token };
  });

  // `read`, not `admin`: listing grants is what an operator dashboard does all
  // day, and the key it carries to do that has no business minting one. (The
  // static adminToken still satisfies it — it satisfies everything.)
  app.get('/v1/sessions', { onRequest: requireRead }, () =>
    signer.sessions().map((s) => redact(s, signer.sessionSpent(s.id), maxLifetime)),
  );

  app.post('/v1/sessions/:id/revoke', { onRequest: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    // Existence checked up front so a durable-store WRITE failure surfaces as
    // a 500 through the error handler instead of masquerading as a 404.
    if (!signer.sessions().some((s) => s.id === id)) {
      return reply.status(404).send({ error: 'unknown_session' });
    }
    await signer.revokeSession(id);
    return reply.status(204).send();
  });

  // Dead grants only — an active session 409s (revoke first). Deleting fails
  // closed (a token with no record refuses as session_unknown).
  app.delete('/v1/sessions/:id', { onRequest: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const session = signer.sessions().find((s) => s.id === id);
    if (!session) {
      return reply.status(404).send({ error: 'unknown_session' });
    }
    if (sessionState(session, Date.now(), maxLifetime) === 'active') {
      return reply
        .status(409)
        .send({ error: 'session_active', reason: 'revoke the session before deleting it' });
    }
    await signer.deleteSession(id);
    return reply.status(204).send();
  });

  // --- The hot path ---
  app.post('/v1/sign', (req) => signer.sign(SignInput.parse(req.body)));

  return app;
}
