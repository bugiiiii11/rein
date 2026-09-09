#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Agent,
  ApprovalGrant,
  ApprovalVerdict,
  ApproverKeyId,
  ApiKeyScope,
  Policy,
  OrgId,
  newId,
  type Decision,
} from '@reinconsole/core';
import { PolicyEngine, IntentInput } from './engine.js';
import { ApiKeyAuth, AuthError } from './auth.js';
import {
  ApprovalError,
  ApprovalService,
  DEFAULT_ESCALATION_TTL_MS,
  type ApprovalChannel,
} from './approvals.js';
import { LoggingApprovalChannel, TelegramApprovalChannel } from './channels.js';

/** Input to register an agent (server fills id/createdAt/status). */
const AgentInput = z.object({
  orgId: OrgId,
  name: z.string().min(1).max(200),
  erc8004Id: z.string().optional(),
  labels: Agent.shape.labels.optional(),
  wallets: Agent.shape.wallets.optional(),
});

const ApiKeyInput = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(ApiKeyScope).min(1),
});

const RotateInput = z.object({ graceMs: z.number().int().nonnegative().optional() });

const ApproverInput = z.object({
  orgId: OrgId,
  name: z.string().min(1).max(200),
  publicKey: z.string().min(1),
});

/** A signed verdict. `decisionId` comes from the path, not the body. */
const GrantInput = z.object({
  intentHash: z.string().min(1),
  verdict: ApprovalVerdict,
  approverKeyId: ApproverKeyId,
  signature: z.string().min(1),
});

export interface ServerOptions {
  /**
   * API-key authentication. Omit for embedded use (the console world and the
   * demos build a loopback engine on an ephemeral port); pass an
   * {@link ApiKeyAuth} and EVERY route but /health demands a credential.
   */
  auth?: ApiKeyAuth;
}

/**
 * What scope a route demands.
 *
 * Fail-closed by construction: reads need `read`, the hot path needs
 * `evaluate`, submitting a signed verdict needs `approve`, and ANYTHING else —
 * including a route added later that nobody thought about here — needs
 * `admin`. A forgotten route is over-protected, never unprotected.
 */
export function requiredScope(method: string, pathname: string): ApiKeyScope {
  if (method === 'GET' || method === 'HEAD') return 'read';
  if (method === 'POST' && pathname === '/v1/evaluate') return 'evaluate';
  if (method === 'POST' && /^\/v1\/approvals\/[^/]+\/resolve$/.test(pathname)) return 'approve';
  return 'admin';
}

/**
 * Build the policy-engine HTTP API. Pass an engine for tests, or let it create
 * a fresh in-memory one. Returns a Fastify instance (not yet listening).
 */
export function buildServer(
  engine: PolicyEngine = new PolicyEngine(),
  options: ServerOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const auth = options.auth;

  // Turn known error types into clean statuses instead of 500s.
  app.setErrorHandler((err: unknown, _req, reply) => {
    if (err instanceof z.ZodError) {
      return reply.status(400).send({ error: 'validation_error', issues: err.issues });
    }
    if (err instanceof AuthError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ApprovalError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    return reply.status(500).send({ error: 'internal_error', message });
  });

  // Auth runs before routing, so an unknown path cannot leak whether it exists.
  // Unauthenticated is 401 with a WWW-Authenticate challenge — never a silent
  // pass, never a 404 pretending the route is missing.
  if (auth) {
    app.addHook('onRequest', async (req, reply) => {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      if (pathname === '/health') return;
      try {
        auth.authenticate(req.headers, requiredScope(req.method, pathname));
      } catch (err) {
        if (err instanceof AuthError) {
          if (err.status === 401) reply.header('WWW-Authenticate', 'Bearer realm="rein-engine"');
          return reply.status(err.status).send({ error: err.code, message: err.message });
        }
        throw err;
      }
      return;
    });
  }

  app.get('/health', () => ({
    status: 'ok',
    publicKey: engine.publicKeyPem,
    // Advertised so a client can tell "this engine wants a key" apart from
    // "my key is wrong" without guessing from a 401.
    auth: auth ? 'api-key' : 'none',
    approvals: engine.approvals ? 'enabled' : 'disabled',
  }));

  // --- Agents ---
  app.post('/v1/agents', (req) => {
    const input = AgentInput.parse(req.body);
    return engine.registerAgent({
      id: newId('agt'),
      orgId: input.orgId,
      name: input.name,
      erc8004Id: input.erc8004Id,
      labels: input.labels ?? [],
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

  // Where the agent's breakers stand right now — read-only observability, so
  // an operator can see WHY an agent is escalating before a challenge lands.
  app.get('/v1/agents/:id/breakers', (req) =>
    engine.breakerStates((req.params as { id: string }).id),
  );

  // --- Policies ---
  app.post('/v1/policies', (req) => engine.addPolicy(Policy.parse(req.body)));
  app.get('/v1/policies', () => engine.policies.list());

  // --- The hot path ---
  app.post('/v1/evaluate', (req) => engine.evaluateIntent(IntentInput.parse(req.body)));

  // --- Audit ---
  app.get('/v1/decisions', () => engine.decisions());

  // --- API keys (admin scope; see requiredScope) ---
  app.post('/v1/keys', async (req, reply) => {
    const a = requireAuth(auth);
    const input = ApiKeyInput.parse(req.body);
    const issued = await a.issue(input);
    // 201 with the secret in the body: the only time it exists outside the
    // caller's hands. Nothing logs it, and no later read can recover it.
    return reply.status(201).send(issued);
  });

  app.get('/v1/keys', () => requireAuth(auth).list());

  app.post('/v1/keys/:id/rotate', async (req) => {
    const { graceMs } = RotateInput.parse(req.body ?? {});
    return requireAuth(auth).rotate((req.params as { id: string }).id, { ...(graceMs !== undefined ? { graceMs } : {}) });
  });

  app.post('/v1/keys/:id/revoke', async (req, reply) => {
    const key = await requireAuth(auth).revoke((req.params as { id: string }).id);
    return key ? key : reply.status(404).send({ error: 'unknown_key_id' });
  });

  // --- Approver keys ---
  app.post('/v1/approvers', async (req, reply) => {
    const input = ApproverInput.parse(req.body);
    return reply.status(201).send(await requireApprovals(engine).registerApprover(input));
  });

  app.get('/v1/approvers', () => requireApprovals(engine).listApprovers());

  app.post('/v1/approvers/:id/revoke', async (req, reply) => {
    const key = await requireApprovals(engine).revokeApprover((req.params as { id: string }).id);
    return key ? key : reply.status(404).send({ error: 'unknown_approver' });
  });

  // --- Escalations awaiting a signature ---
  app.get('/v1/approvals', () => requireApprovals(engine).pending());

  app.get('/v1/approvals/:decisionId', (req, reply) => {
    const approvals = requireApprovals(engine);
    const request = approvals.get((req.params as { decisionId: string }).decisionId);
    if (!request) return reply.status(404).send({ error: 'unknown_request' });
    const decision = request.finalDecisionId
      ? findDecision(engine, request.finalDecisionId)
      : undefined;
    // The challenges are derived, not stored — recomputing them here means a
    // client never has to trust its own canonicalization to sign correctly.
    return { request, challenges: approvals.challengesFor(request), ...(decision ? { decision } : {}) };
  });

  app.post('/v1/approvals/:decisionId/resolve', async (req) => {
    requireApprovals(engine);
    const body = GrantInput.parse(req.body);
    const grant = ApprovalGrant.parse({
      decisionId: (req.params as { decisionId: string }).decisionId,
      ...body,
    });
    return engine.resolveEscalation(grant);
  });

  return app;
}

function requireAuth(auth: ApiKeyAuth | undefined): ApiKeyAuth {
  if (!auth) {
    throw new AuthError(404, 'unknown_key_id', 'this engine runs without API-key auth');
  }
  return auth;
}

function requireApprovals(engine: PolicyEngine): ApprovalService {
  if (!engine.approvals) {
    throw new ApprovalError(404, 'unknown_request', 'this engine has no approval service');
  }
  return engine.approvals;
}

/** Newest-first scan: a resolution is always near the end of the chain. */
function findDecision(engine: PolicyEngine, id: string): Decision | undefined {
  const all = engine.decisions();
  for (let i = all.length - 1; i >= 0; i -= 1) {
    if (all[i]?.id === id) return all[i];
  }
  return undefined;
}

// --- Standalone boot ---

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

/**
 * Build the auth layer from the environment, or explain why there is none.
 *
 * `REIN_ENGINE_API_KEY` seeds one or more admin secrets (comma-separated) —
 * enough to bootstrap, after which `/v1/keys` issues narrower ones.
 */
export async function authFromEnv(env: NodeJS.ProcessEnv): Promise<ApiKeyAuth | undefined> {
  const raw = env['REIN_ENGINE_API_KEY']?.trim();
  if (!raw) return undefined;
  const auth = new ApiKeyAuth();
  const secrets = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const [i, secret] of secrets.entries()) {
    await auth.issue({ name: `env-key-${i + 1}`, scopes: ['admin'], secret });
  }
  return auth.hasKeys() ? auth : undefined;
}

/** The approval tier the standalone server runs with. */
export function approvalsFromEnv(env: NodeJS.ProcessEnv): ApprovalService {
  const channels: ApprovalChannel[] = [new LoggingApprovalChannel()];
  const botToken = env['REIN_TELEGRAM_BOT_TOKEN']?.trim();
  const chatId = env['REIN_TELEGRAM_CHAT_ID']?.trim();
  if (botToken && chatId) channels.push(new TelegramApprovalChannel({ botToken, chatId }));
  const ttl = Number(env['REIN_ESCALATION_TTL_MS'] ?? DEFAULT_ESCALATION_TTL_MS);
  return new ApprovalService({
    channels,
    ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_ESCALATION_TTL_MS,
    onDeliveryError: (channel, error) =>
      console.error(`[rein] approval channel "${channel}" failed:`, error),
  });
}

/**
 * Where to bind, given whether auth exists.
 *
 * The rule: an engine with no API key never listens on a public interface. It
 * binds loopback instead, so the documented `localhost:8787` quickstart is
 * unchanged while an unauthenticated engine cannot be exposed by accident.
 * Asking for a public bind without a key is a startup ERROR, not a warning —
 * and `REIN_ENGINE_AUTH=off` is the explicit, deliberate override.
 */
export function resolveHost(
  env: NodeJS.ProcessEnv,
  hasAuth: boolean,
): { host: string; warning?: string } {
  const requested = env['HOST']?.trim();
  const optedOut = env['REIN_ENGINE_AUTH']?.trim().toLowerCase() === 'off';
  if (hasAuth) return { host: requested || '0.0.0.0' };
  if (optedOut) {
    return {
      host: requested || '0.0.0.0',
      warning:
        'REIN_ENGINE_AUTH=off — this engine is answering unauthenticated requests. ' +
        'Anyone who can reach it can rewrite policy and authorize spend.',
    };
  }
  if (requested && !LOOPBACK.has(requested)) {
    throw new Error(
      `refusing to bind ${requested} without authentication.\n` +
        '  Set REIN_ENGINE_API_KEY=<secret> to protect the engine, or\n' +
        '  set REIN_ENGINE_AUTH=off to accept an open engine deliberately.',
    );
  }
  return {
    host: requested || '127.0.0.1',
    warning:
      'no REIN_ENGINE_API_KEY set — binding 127.0.0.1 only. Set one before exposing this engine.',
  };
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
  const auth = await authFromEnv(process.env);

  let host: string;
  try {
    const resolved = resolveHost(process.env, auth !== undefined);
    host = resolved.host;
    if (resolved.warning) console.warn(`[rein] WARNING: ${resolved.warning}`);
  } catch (err) {
    // A refused bind is a configuration error, not a crash: say what to do.
    console.error(`[rein] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }

  const engine = new PolicyEngine({ approvals: approvalsFromEnv(process.env) });
  engine.startExpirySweeper();
  const app = buildServer(engine, { ...(auth ? { auth } : {}) });
  app
    .listen({ port, host })
    .then(() =>
      console.log(
        `[rein] policy-engine listening on http://${host}:${port} (auth: ${auth ? 'api-key' : 'none'})`,
      ),
    )
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
