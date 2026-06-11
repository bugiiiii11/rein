import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ReinEvent, ReputationSubject } from '@rein/core';
import { ReputationGraph } from './graph.js';

const ReportInput = z.object({
  subject: ReputationSubject,
  kind: z.enum(['dispute', 'endorsement']),
  at: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
});

const ScoresQuery = z.object({ kind: z.enum(['agent', 'vendor']).optional() });

/**
 * Build the graph HTTP API. Remote producers POST their events here; anyone
 * can read scores with the evidence behind them. Pass a graph for tests, or
 * let it create a fresh in-memory one.
 */
export function buildGraphServer(graph: ReputationGraph = new ReputationGraph()): FastifyInstance {
  const app = Fastify({ logger: false });

  // Turn ZodErrors into clean 400s instead of 500s.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'validation_error', issues: err.issues });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: 'internal_error', message });
  });

  app.get('/health', () => ({ status: 'ok', subjects: graph.subjects() }));

  // --- Ingestion ---
  app.post('/v1/events', (req) => {
    const events = z.union([ReinEvent.transform((e) => [e]), z.array(ReinEvent)]).parse(req.body);
    for (const event of events) graph.ingest(event);
    return { ingested: events.length };
  });

  app.post('/v1/reports', (req) => {
    const input = ReportInput.parse(req.body);
    graph.report(input);
    return graph.score(input.subject);
  });

  // --- Scores ---
  app.get('/v1/scores', (req) => {
    const { kind } = ScoresQuery.parse(req.query);
    return graph.scores(kind);
  });

  app.get('/v1/scores/:kind/:id', (req, reply) => {
    const subject = ReputationSubject.parse(req.params);
    const explanation = graph.explain(subject);
    if (!explanation) {
      return reply
        .status(404)
        .send({ error: 'not_found', message: `no evidence for ${subject.kind} ${subject.id}` });
    }
    return explanation;
  });

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
  const port = Number(process.env.PORT ?? 8788);
  const host = process.env.HOST ?? '0.0.0.0';
  const app = buildGraphServer();
  app
    .listen({ port, host })
    .then(() => console.log(`[rein] graph listening on http://${host}:${port}`))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
