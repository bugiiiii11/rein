import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Agent, Policy, OrgId, newId } from '@rein/core';
import { PolicyEngine, IntentInput } from './engine.js';

/** Input to register an agent (server fills id/createdAt/status). */
const AgentInput = z.object({
  orgId: OrgId,
  name: z.string().min(1).max(200),
  erc8004Id: z.string().optional(),
  wallets: Agent.shape.wallets.optional(),
});

/**
 * Build the policy-engine HTTP API. Pass an engine for tests, or let it create
 * a fresh in-memory one. Returns a Fastify instance (not yet listening).
 */
export function buildServer(engine: PolicyEngine = new PolicyEngine()): FastifyInstance {
  const app = Fastify({ logger: false });

  // Turn ZodErrors into clean 400s instead of 500s.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'validation_error', issues: err.issues });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: 'internal_error', message });
  });

  app.get('/health', () => ({ status: 'ok', publicKey: engine.publicKeyPem }));

  // --- Agents ---
  app.post('/v1/agents', (req) => {
    const input = AgentInput.parse(req.body);
    return engine.registerAgent({
      id: newId('agt'),
      orgId: input.orgId,
      name: input.name,
      erc8004Id: input.erc8004Id,
      wallets: input.wallets ?? [],
      status: 'active',
      createdAt: new Date(),
    });
  });

  app.get('/v1/agents', () => engine.agents.list());

  app.post('/v1/agents/:id/freeze', async (req, reply) => {
    await engine.freeze((req.params as { id: string }).id);
    return reply.status(204).send();
  });

  app.post('/v1/agents/:id/unfreeze', async (req, reply) => {
    await engine.unfreeze((req.params as { id: string }).id);
    return reply.status(204).send();
  });

  // --- Policies ---
  app.post('/v1/policies', (req) => engine.addPolicy(Policy.parse(req.body)));
  app.get('/v1/policies', () => engine.policies.list());

  // --- The hot path ---
  app.post('/v1/evaluate', (req) => engine.evaluateIntent(IntentInput.parse(req.body)));

  // --- Audit ---
  app.get('/v1/decisions', () => engine.decisions());

  return app;
}

// Start the server when run directly (tsx/node), not when imported.
function isMainModule(): boolean {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? '0.0.0.0';
  const app = buildServer();
  app
    .listen({ port, host })
    .then(() => console.log(`[rein] policy-engine listening on http://${host}:${port}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
