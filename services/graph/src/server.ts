import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ReinEvent, ReputationSubject } from '@reinconsole/core';
import { ApiKeyAuth, AuthError } from '@reinconsole/core/auth';
import { ReputationGraph } from './graph.js';

const ReportInput = z.object({
  subject: ReputationSubject,
  kind: z.enum(['dispute', 'endorsement']),
  at: z.coerce.date().optional(),
  note: z.string().max(500).optional(),
});

const ScoresQuery = z.object({ kind: z.enum(['agent', 'vendor']).optional() });

const LinkInput = z
  .object({
    canonical: ReputationSubject,
    alias: ReputationSubject,
  })
  // Merging across kinds would delete a vendor row into an agent identity
  // (silently dropping the host from syncVendors) — always a caller bug.
  .refine((l) => l.canonical.kind === l.alias.kind, {
    message: 'canonical and alias must be the same kind',
  });

export interface GraphServerOptions {
  /**
   * API-key authentication for the WRITE routes. Omit for embedded use (the
   * console world holds the graph object directly) or for a loopback-only
   * process; pass an {@link ApiKeyAuth} and every write demands a `report`
   * scope while reads stay open.
   */
  auth?: ApiKeyAuth;
}

/** Writes accept evidence; reads only reflect it back. */
function isWrite(method: string): boolean {
  return method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS';
}

/**
 * Build the graph HTTP API. Remote producers POST their events here; anyone
 * can read scores with the evidence behind them. Pass a graph for tests, or
 * let it create a fresh in-memory one.
 *
 * READS ARE OPEN BY DESIGN and that is the whole point of a reputation graph:
 * a score nobody can read governs nothing. WRITES are the asymmetry — an event
 * posted here becomes evidence about a subject that did not post it — so when
 * `auth` is supplied they require the `report` scope. Without `auth` the server
 * is exactly as open as it always was, which is why the bins that expose it
 * refuse a public bind unless a key exists or the operator says otherwise.
 */
export function buildGraphServer(
  graph: ReputationGraph = new ReputationGraph(),
  options: GraphServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const auth = options.auth;

  // Turn ZodErrors into clean 400s instead of 500s.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'validation_error', issues: err.issues });
    }
    if (AuthError.is(err)) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: 'internal_error', message });
  });

  // Auth runs before routing, so an unknown write path cannot leak whether it
  // exists. A missing credential is a 401 with a challenge, never a silent
  // pass and never a 404 pretending the route moved.
  if (auth) {
    app.addHook('onRequest', async (req, reply) => {
      if (!isWrite(req.method)) return;
      try {
        auth.authenticate(req.headers, 'report');
      } catch (err) {
        if (AuthError.is(err)) {
          if (err.status === 401) reply.header('WWW-Authenticate', 'Bearer realm="rein-graph"');
          return reply.status(err.status).send({ error: err.code, message: err.message });
        }
        throw err;
      }
      return;
    });
  }

  app.get('/health', () => ({
    status: 'ok',
    subjects: graph.subjects(),
    // Advertised so a producer can tell "this graph wants a key" apart from
    // "my key is wrong" without guessing from a 401.
    auth: auth ? 'api-key' : 'none',
  }));

  // --- Ingestion ---
  // The HTTP path can await durability even though the in-process bus path
  // cannot — flush the durable writes before answering so a POST that returns
  // 200 is persisted.
  app.post('/v1/events', async (req) => {
    const events = z.union([ReinEvent.transform((e) => [e]), z.array(ReinEvent)]).parse(req.body);
    for (const event of events) graph.ingest(event);
    await graph.flush();
    return { ingested: events.length };
  });

  app.post('/v1/reports', async (req) => {
    const input = ReportInput.parse(req.body);
    graph.report(input);
    await graph.flush();
    return graph.score(input.subject);
  });

  // --- Identity links ---
  // Unverified by DESIGN: this endpoint's trust level equals POST /v1/events —
  // whoever can post events can already fabricate the evidence itself. On-chain
  // verification belongs to the CALLER (@reinconsole/erc8004 derives link facts from
  // the Identity Registry, then asserts them here).
  app.post('/v1/links', async (req) => {
    const links = z.union([LinkInput.transform((l) => [l]), z.array(LinkInput)]).parse(req.body);
    for (const link of links) graph.link(link.canonical, link.alias);
    await graph.flush(); // durable merges land before the 200 (same contract as /v1/events)
    return { linked: links.length };
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

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Build the graph's auth layer from the environment, or explain why there is
 * none. `REIN_GRAPH_API_KEY` seeds one or more comma-separated secrets.
 *
 * They are seeded with `report` and nothing else: the graph has no key-issuing
 * routes to bootstrap (unlike the engine, which seeds `admin` so `/v1/keys` is
 * reachable), so an `admin` secret here would grant authority no route needs.
 */
export async function graphAuthFromEnv(env: NodeJS.ProcessEnv): Promise<ApiKeyAuth | undefined> {
  const raw = env['REIN_GRAPH_API_KEY']?.trim();
  if (!raw) return undefined;
  const auth = new ApiKeyAuth();
  const secrets = raw
    .split(',')
    .map((secret) => secret.trim())
    .filter(Boolean);
  for (const [i, secret] of secrets.entries()) {
    await auth.issue({ name: `env-key-${i + 1}`, scopes: ['report'], secret });
  }
  return auth.hasKeys() ? auth : undefined;
}

/**
 * Where a graph process binds, given whether auth exists.
 *
 * Until D1(a) the graph had no key to trade, so the only trade available was a
 * statement: `REIN_GRAPH_PUBLIC=1`. Now that writes can demand a `report` key,
 * the rule matches the engine's — a key buys a public bind, and asking for one
 * without a key is a startup ERROR rather than a warning. `REIN_GRAPH_PUBLIC=1`
 * survives as the deliberate override for an open graph, because a read-only
 * showcase is a real deployment and reads were never the exposure.
 */
export function resolveGraphHost(
  env: NodeJS.ProcessEnv,
  hasAuth = false,
): { host: string; warning?: string } {
  const requested = env['HOST']?.trim();
  const optedIn = env['REIN_GRAPH_PUBLIC']?.trim() === '1';
  if (hasAuth) return { host: requested || '0.0.0.0' };
  if (optedIn) {
    return {
      host: requested || '0.0.0.0',
      warning:
        'REIN_GRAPH_PUBLIC=1 — this reputation graph is answering unauthenticated requests. ' +
        'Anyone who can reach it can write evidence that moves scores.',
    };
  }
  if (requested && !LOOPBACK.has(requested)) {
    throw new Error(
      `refusing to bind ${requested}: the reputation graph has no authentication.` +
        '\n  Set REIN_GRAPH_API_KEY=<secret> to protect its writes, or' +
        '\n  set REIN_GRAPH_PUBLIC=1 to expose an open graph deliberately.',
    );
  }
  return { host: requested || '127.0.0.1' };
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
  // This block used to default to 0.0.0.0 with no auth at all — the in-memory
  // twin of the exposure D1 closed on the durable bin, and the more reachable
  // of the two, since it needs no data directory to run.
  graphAuthFromEnv(process.env)
    .then((auth) => {
      const { host, warning } = resolveGraphHost(process.env, auth !== undefined);
      if (warning) console.warn(`[rein] ${warning}`);
      const app = buildGraphServer(new ReputationGraph(), { ...(auth ? { auth } : {}) });
      return app
        .listen({ port, host })
        .then(() =>
          console.log(
            `[rein] graph listening on http://${host}:${port} (auth: ${auth ? 'api-key' : 'none'})`,
          ),
        );
    })
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
