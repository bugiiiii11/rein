import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentId, Decision, DecimalString, PaymentIntent, type Session } from '@rein/core';
import { PaymentRequirement } from '@rein/sdk';
import { SignerError } from './errors.js';
import type { SessionSigner } from './signer.js';

const SessionInput = z.object({
  agentId: AgentId,
  capAmount: DecimalString.optional(),
  maxPerPayment: DecimalString.optional(),
  ttlSeconds: z.number().int().positive().optional(),
});

const SignInput = z.object({
  sessionToken: z.string().min(1),
  requirement: PaymentRequirement,
  intent: PaymentIntent,
  decision: Decision,
});

/** What the API shows of a session: everything but the token hash. */
function redact(session: Session, spent: string) {
  const { tokenHash: _tokenHash, ...rest } = session;
  return { ...rest, spent };
}

/**
 * Build the signer HTTP API. Wallet keys are registered in-process on the
 * {@link SessionSigner} before serving — there is deliberately no endpoint
 * that accepts a private key.
 */
export function buildSignerServer(signer: SessionSigner): FastifyInstance {
  const app = Fastify({ logger: false });

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

  app.get('/health', () => ({ status: 'ok' }));

  // --- Sessions ---
  // Writes are awaited: on a durable store, a 2xx means the grant (or the
  // revocation) is on disk, not merely in memory.
  app.post('/v1/sessions', async (req) => {
    const input = SessionInput.parse(req.body);
    const created = await signer.createSession(input);
    return { session: redact(created.session, '0'), token: created.token };
  });

  app.get('/v1/sessions', () =>
    signer.sessions().map((s) => redact(s, signer.sessionSpent(s.id))),
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

  // --- The hot path ---
  app.post('/v1/sign', (req) => signer.sign(SignInput.parse(req.body)));

  return app;
}
