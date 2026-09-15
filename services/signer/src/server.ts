import { createHash, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import { AgentId, Decision, DecimalString, PaymentIntent, type Session } from '@reinconsole/core';
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
   */
  adminToken?: string;
  /**
   * The explicit, deliberate opt-out — the ONLY way to serve an unauthenticated
   * admin surface. Passing it is a statement; forgetting `adminToken` is not.
   */
  adminAuth?: 'off';
}

/** Digest comparison that does not leak a prefix match through timing. */
function secretsEqual(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** `Authorization: Bearer <secret>` first, `X-Api-Key` second — as the engine reads it. */
function readCredential(req: FastifyRequest): string | undefined {
  const auth = first(req.headers.authorization)?.trim();
  if (auth) {
    const match = /^Bearer\s+(.+)$/i.exec(auth);
    if (match?.[1]) return match[1].trim();
  }
  const apiKey = first(req.headers['x-api-key'])?.trim();
  return apiKey === undefined || apiKey === '' ? undefined : apiKey;
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
 * `POST /v1/sign` is deliberately NOT behind it: the session token in the body
 * IS that route's credential — scoped, capped, expiring and revocable, which
 * is the whole point of the tier. `/health` stays open for probes.
 */
export function buildSignerServer(
  signer: SessionSigner,
  options: SignerServerOptions = {},
): FastifyInstance {
  const adminToken = options.adminToken?.trim();
  if (adminToken && options.adminAuth === 'off') {
    throw new Error(
      'buildSignerServer: pass adminToken OR adminAuth: "off", not both — which one governs is not for this function to guess',
    );
  }
  if (!adminToken && options.adminAuth !== 'off') {
    throw new Error(
      'buildSignerServer: the session-admin routes mint spending authority against wallets this process holds.\n' +
        '  Pass { adminToken: <secret> } to protect them, or\n' +
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
  const requireAdmin = (req: FastifyRequest, _reply: unknown, done: (err?: Error) => void) => {
    if (adminToken === undefined) return done();
    const presented = readCredential(req);
    if (presented === undefined) {
      return done(
        new AdminAuthError('missing_credentials', 'missing admin token (Authorization: Bearer ...)'),
      );
    }
    if (!secretsEqual(presented, adminToken)) {
      return done(new AdminAuthError('invalid_credentials', 'admin token is not valid'));
    }
    return done();
  };

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof AdminAuthError) {
      // A challenge, never a silent 404: an operator holding the wrong secret
      // should learn that, not conclude the route moved.
      return reply
        .status(401)
        .header('www-authenticate', 'Bearer realm="rein-signer"')
        .send({ error: 'unauthorized', code: err.code, reason: err.message });
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

  app.get('/health', () => ({
    status: 'ok',
    maxSessionLifetimeSeconds: maxLifetime,
    adminAuth: adminToken === undefined ? 'off' : 'bearer',
  }));

  // --- Sessions ---
  // Writes are awaited: on a durable store, a 2xx means the grant (or the
  // revocation) is on disk, not merely in memory.
  app.post('/v1/sessions', { onRequest: requireAdmin }, async (req) => {
    const input = SessionInput.parse(req.body);
    const created = await signer.createSession(input);
    return { session: redact(created.session, '0', maxLifetime), token: created.token };
  });

  app.get('/v1/sessions', { onRequest: requireAdmin }, () =>
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
