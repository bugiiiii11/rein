import Fastify, { type FastifyInstance } from 'fastify';
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
 * Build the signer HTTP API. Wallet keys are registered in-process on the
 * {@link SessionSigner} before serving — there is deliberately no endpoint
 * that accepts a private key.
 */
export function buildSignerServer(signer: SessionSigner): FastifyInstance {
  const app = Fastify({ logger: false });
  const maxLifetime = signer.maxSessionLifetimeSeconds;
  const SessionInput = sessionInputSchema(maxLifetime);

  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'validation_error', issues: err.issues });
    }
    if (err instanceof SignerError) {
      return reply.status(403).send({ error: 'refused', code: err.code, reason: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: 'internal_error', message });
  });

  app.get('/health', () => ({ status: 'ok', maxSessionLifetimeSeconds: maxLifetime }));

  // --- Sessions ---
  // Writes are awaited: on a durable store, a 2xx means the grant (or the
  // revocation) is on disk, not merely in memory.
  app.post('/v1/sessions', async (req) => {
    const input = SessionInput.parse(req.body);
    const created = await signer.createSession(input);
    return { session: redact(created.session, '0', maxLifetime), token: created.token };
  });

  app.get('/v1/sessions', () =>
    signer.sessions().map((s) => redact(s, signer.sessionSpent(s.id), maxLifetime)),
  );

  app.post('/v1/sessions/:id/revoke', async (req, reply) => {
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
  app.delete('/v1/sessions/:id', async (req, reply) => {
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
