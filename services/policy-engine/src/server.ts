#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import Fastify, { type FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  Agent,
  ApprovalGrant,
  ApprovalVerdict,
  ApproverKeyId,
  ApiKeyScope,
  AgentId,
  Policy,
  OrgId,
  SettlementReport,
  Heartbeat,
  LivenessWatchInput,
  Window,
  newId,
  type Decision,
} from '@reinconsole/core';
import { PolicyEngine, IntentInput } from './engine.js';
import type { ReconcileOptions } from './reconciliation.js';
import { ApiKeyAuth, AuthError, hashSecret, type ApiKeyStorePort } from '@reinconsole/core/auth';
import {
  ApprovalError,
  ApprovalService,
  DEFAULT_ESCALATION_TTL_MS,
  type ApprovalChannel,
} from './approvals.js';
import { LoggingChannel, TelegramChannel } from './channels.js';
import type { ApprovalStorePort } from './approvals.js';
import type { LivenessStorePort } from './liveness.js';
import { LivenessError, LivenessMonitor, type AlertChannel } from './liveness.js';

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
  // Reporting a settlement rides the same scope as spending, because the
  // reporter IS the spender: the guard that made the payment is the component
  // that sees the vendor confirm it. Nothing is granted by this — a settlement
  // report can only close a reconciliation gap, never authorize a payment. The
  // worst a stolen evaluate key does here is hide gaps it created, and a key
  // that can spend can already do far worse.
  if (method === 'POST' && pathname === '/v1/settlements') return 'evaluate';
  // A heartbeat rides `evaluate` for the same reason, and with even less at
  // stake: the agent that would spend is the natural reporter of its own
  // liveness, and every intent it submits is already a sighting. The worst a
  // stolen evaluate key does here is keep a dead agent looking alive — and a
  // key that can spend can simply spend, which looks alive too.
  if (method === 'POST' && /^\/v1\/agents\/[^/]+\/heartbeat$/.test(pathname)) return 'evaluate';
  if (method === 'POST' && /^\/v1\/approvals\/[^/]+\/resolve$/.test(pathname)) return 'approve';
  return 'admin';
}

/** Query parsing for `GET /v1/reconciliation`, shared with the tests. */
const ReconcileQuery = z.object({
  window: Window.optional(),
  graceMs: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  agentId: AgentId.optional(),
});

export function reconcileOptionsFromQuery(query: unknown): ReconcileOptions {
  const q = ReconcileQuery.parse(query ?? {});
  return {
    ...(q.window !== undefined ? { window: q.window } : {}),
    ...(q.graceMs !== undefined ? { graceMs: q.graceMs } : {}),
    ...(q.limit !== undefined ? { limit: q.limit } : {}),
    ...(q.agentId !== undefined ? { agentId: q.agentId } : {}),
  };
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
    if (AuthError.is(err)) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof ApprovalError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof LivenessError) {
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
        if (AuthError.is(err)) {
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

  // --- Dead-man monitoring (B2) ---
  // Declaring an expectation is configuration, so it sits at `admin`; the
  // heartbeat that answers it does not (see requiredScope).
  app.put('/v1/agents/:id/liveness', async (req, reply) => {
    const input = LivenessWatchInput.parse({
      ...(req.body as object | null ?? {}),
      agentId: (req.params as { id: string }).id,
    });
    return reply.status(201).send(await requireLiveness(engine).watch(input));
  });

  app.delete('/v1/agents/:id/liveness', async (req, reply) => {
    const removed = await requireLiveness(engine).unwatch((req.params as { id: string }).id);
    return removed ? reply.status(204).send() : reply.status(404).send({ error: 'not_watched' });
  });

  app.post('/v1/agents/:id/heartbeat', async (req, reply) => {
    requireLiveness(engine);
    const beat = Heartbeat.parse({
      ...(req.body as object | null ?? {}),
      agentId: (req.params as { id: string }).id,
    });
    const state = await engine.heartbeat(beat);
    // 404 rather than a silent 202: an agent nobody watches has nowhere to
    // record a heartbeat, and a reporter that believes it is being monitored
    // when it is not is the exact failure this feature exists to prevent.
    return state ? reply.status(202).send(state) : reply.status(404).send({ error: 'not_watched' });
  });

  app.get('/v1/liveness', () => engine.livenessStates());

  // --- Policies ---
  app.post('/v1/policies', (req) => engine.addPolicy(Policy.parse(req.body)));
  app.get('/v1/policies', () => engine.policies.list());

  // --- The hot path ---
  app.post('/v1/evaluate', (req) => engine.evaluateIntent(IntentInput.parse(req.body)));

  // --- Audit ---
  app.get('/v1/decisions', () => engine.decisions());

  // --- Reconciliation (B1): allowed but never settled ---
  // The write is the settlement half of the join — see requiredScope for why
  // it sits at `evaluate` rather than `admin`.
  app.post('/v1/settlements', async (req, reply) =>
    reply.status(202).send(await engine.recordSettlement(SettlementReport.parse(req.body))),
  );

  app.get('/v1/reconciliation', (req) => engine.reconcile(reconcileOptionsFromQuery(req.query)));

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

function requireLiveness(engine: PolicyEngine): LivenessMonitor {
  if (!engine.liveness) {
    throw new LivenessError(
      404,
      'liveness_disabled',
      'this engine has no liveness monitor; nothing is being watched',
    );
  }
  return engine.liveness;
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
 *
 * Pass `store` (a durable one, `reinStore.apiKeys`) and those narrower keys
 * outlive the process: without it every key `/v1/keys` ever issued dies at the
 * next restart, and — the direction that matters — every key an operator
 * REVOKED comes back alive, because revocation is a write too. The env secrets
 * are re-seeded either way; they are configuration, not state.
 */
export async function authFromEnv(
  env: NodeJS.ProcessEnv,
  store?: ApiKeyStorePort,
): Promise<ApiKeyAuth | undefined> {
  const raw = env['REIN_ENGINE_API_KEY']?.trim();
  if (!raw) return undefined;
  const auth = new ApiKeyAuth({ ...(store ? { store } : {}) });
  const secrets = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const [i, secret] of secrets.entries()) {
    // Idempotent against a durable store: the same env secret seeded on every
    // boot must not append a new row (and a second record sharing one secret
    // hash would shadow the first in the hash index anyway).
    if (store?.byHash(hashSecret(secret))) continue;
    await auth.issue({ name: `env-key-${i + 1}`, scopes: ['admin'], secret });
  }
  return auth.hasKeys() ? auth : undefined;
}

/**
 * Delivery channels shared by the approval tier and the dead-man alarms. The
 * log is always on. Telegram needs BOTH variables: one without the other is a
 * misconfiguration, and dropping the channel silently would leave an operator
 * who set a token believing a human is paged when nobody is.
 */
export function channelsFromEnv(env: NodeJS.ProcessEnv): (ApprovalChannel & AlertChannel)[] {
  const channels: (ApprovalChannel & AlertChannel)[] = [new LoggingChannel()];
  const botToken = env['REIN_TELEGRAM_BOT_TOKEN']?.trim();
  const chatId = env['REIN_TELEGRAM_CHAT_ID']?.trim();
  if (Boolean(botToken) !== Boolean(chatId)) {
    throw new TypeError(
      'REIN_TELEGRAM_BOT_TOKEN and REIN_TELEGRAM_CHAT_ID must be set together: ' +
        `${botToken ? 'REIN_TELEGRAM_CHAT_ID' : 'REIN_TELEGRAM_BOT_TOKEN'} is missing`,
    );
  }
  if (botToken && chatId) channels.push(new TelegramChannel({ botToken, chatId }));
  return channels;
}

/**
 * The dead-man monitor the standalone server runs with (B2).
 *
 * It watches nobody until an expectation is declared — the alarms go to the
 * same channels the approval tier uses, because a human who cares that a
 * payment needs signing is the human who cares that an agent stopped.
 */
/**
 * The message and nothing else. The channel error hooks below log through
 * this rather than passing the error object along, because a transport error
 * can quote the request that failed -- and for Telegram the request URL IS the
 * bot token. TelegramChannel redacts its own failures; this keeps the rule
 * even for a channel that does not.
 */
function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export function livenessFromEnv(
  env: NodeJS.ProcessEnv,
  options: { store?: LivenessStorePort } = {},
): LivenessMonitor {
  return new LivenessMonitor({
    ...(options.store ? { store: options.store } : {}),
    channels: channelsFromEnv(env),
    // Message only, never the error object: a channel's transport failure can
    // quote the request it made, and for Telegram the request IS the token.
    onAlertError: (channel, error) =>
      console.error(`[rein] liveness channel "${channel}" failed: ${messageOf(error)}`),
    onSightingError: (agentId, error) =>
      console.error(`[rein] liveness sighting for ${agentId} was not recorded:`, error),
  });
}

/** The approval tier the standalone server runs with. */
export function approvalsFromEnv(
  env: NodeJS.ProcessEnv,
  options: { store?: ApprovalStorePort } = {},
): ApprovalService {
  const channels: ApprovalChannel[] = channelsFromEnv(env);
  const ttl = Number(env['REIN_ESCALATION_TTL_MS'] ?? DEFAULT_ESCALATION_TTL_MS);
  return new ApprovalService({
    ...(options.store ? { store: options.store } : {}),
    channels,
    ttlMs: Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_ESCALATION_TTL_MS,
    onDeliveryError: (channel, error) =>
      console.error(`[rein] approval channel "${channel}" failed: ${messageOf(error)}`),
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

  const engine = new PolicyEngine({
    approvals: approvalsFromEnv(process.env),
    liveness: livenessFromEnv(process.env),
  });
  engine.startExpirySweeper();
  // Nothing else will ever call the engine about an agent that stopped.
  engine.startLivenessSweeper();
  const app = buildServer(engine, { ...(auth ? { auth } : {}) });
  app
    .listen({ port, host })
    .then(() =>
      console.log(
        `[rein] policy-engine listening on http://${host}:${(app.server.address() as AddressInfo).port} ` +
          `(auth: ${auth ? 'api-key' : 'none'})`,
      ),
    )
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
