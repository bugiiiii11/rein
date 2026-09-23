#!/usr/bin/env node
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
} from 'fastify';
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
import { TenantError, ownsOrg, scopeOf, type TenantScope } from './tenant.js';
import { buildRateLimiters, rateLimitFromEnv, type RateLimitOptions } from './rate-limit.js';
import type { ApprovalStorePort } from './approvals.js';
import type { LivenessStorePort } from './liveness.js';
import { LivenessError, LivenessMonitor, type AlertChannel } from './liveness.js';

/** Input to register an agent (server fills id/createdAt/status). */
const AgentInput = z.object({
  /**
   * Optional, because an org-SCOPED caller has no business naming one: its own
   * org is applied regardless, and a tenant that has never been told its org
   * id would otherwise be unable to register an agent at all. Still required
   * of an unscoped operator key, which has to say which org the agent is in.
   */
  orgId: OrgId.optional(),
  name: z.string().min(1).max(200),
  erc8004Id: z.string().optional(),
  labels: Agent.shape.labels.optional(),
  wallets: Agent.shape.wallets.optional(),
});

const ApiKeyInput = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(ApiKeyScope).min(1),
  /** Confine the new key to an org. Forced to the caller's own when scoped. */
  orgId: OrgId.optional(),
  /** Narrow the new key to named agents (see `ApiKey.agentIds`). */
  agentIds: z.array(AgentId).max(64).optional(),
});

const RotateInput = z.object({ graceMs: z.number().int().nonnegative().optional() });

const ApproverInput = z.object({
  /** Optional for a scoped caller, for the same reason as `AgentInput.orgId`. */
  orgId: OrgId.optional(),
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
  /**
   * Rate limiting, per IP before auth and per API key after it. Omit — as
   * every embedded caller does — and there is no limiter at all: an engine
   * sharing a process with its only caller can only ever throttle the
   * application that owns it. The bins build this from
   * {@link rateLimitFromEnv}.
   */
  rateLimit?: RateLimitOptions;
  /**
   * WHICH peers may name a request's client through `X-Forwarded-For`. Required
   * behind a reverse proxy (Railway is one), where every socket address is the
   * proxy's and an untrusting engine would rate-limit all tenants as one
   * client.
   *
   * **Identify the peer; do not count hops. That distinction is the whole
   * security of the per-IP limiter.** `true` means "believe the left-most
   * entry", and the left-most entry is whatever the CLIENT sent: a proxy
   * APPENDS the address it observed, it does not erase what arrived. So `true`
   * behind Railway is still forgeable — a caller who rotates the header mints
   * itself a fresh bucket per request, and the per-IP limiter is precisely the
   * one bounding what an UNAUTHENTICATED caller can make this process do.
   *
   * A trust SPEC (proxy-addr syntax: `loopback`, `linklocal`, `uniquelocal`, or
   * IP/CIDR entries) instead walks inward from the socket and stops at the
   * first address that is not a trusted peer, which is the one the nearest
   * trusted proxy actually observed. No header can move it, at any depth, and a
   * client connecting DIRECTLY is never believed at all. Build it with
   * {@link parseTrustProxy}; `REIN_TRUST_PROXY=1` resolves to the private
   * ranges, which is where a managed platform's proxy lives.
   *
   * Name too much and you are back to forgeable. Name too little and the
   * resolved address is the proxy's own, so every caller shares one bucket —
   * noisy and obvious, where too much is silent. Off by default.
   */
  trustProxy?: boolean | string;
}

/**
 * Request body ceiling. Every body this API accepts is a handful of small JSON
 * objects — the largest realistic one is a policy with many rules — so 64 KiB
 * is generous by two orders of magnitude while still bounding what an
 * unauthenticated caller can make the process buffer. Fastify answers a body
 * over the limit with 413 before the route ever runs.
 */
const BODY_LIMIT_BYTES = 65_536;

/**
 * How long the server waits for a complete request. A socket that opens and
 * dribbles bytes forever costs a connection slot indefinitely otherwise; this
 * is the read side only, so it bounds nothing a handler does.
 */
const REQUEST_TIMEOUT_MS = 30_000;

/** Page size for `GET /v1/decisions` when the caller names none. */
const DECISIONS_DEFAULT_LIMIT = 500;
/** The most decisions one page will ever carry, whatever `limit` asks for. */
const DECISIONS_MAX_LIMIT = 1000;

/**
 * Paging for the decision chain.
 *
 * `after` is a POSITION in the sequence this caller can see — for an unscoped
 * operator that is the chain index itself, and for an org-scoped caller it is
 * an index into its own filtered view. Either way the sequence is append-only
 * (decisions are never pruned, see `services/store/README.md`), so a position
 * means the same thing on the next request as it did on the last one.
 */
const DecisionsQuery = z.object({
  /** Index of the last decision the caller already has; the page starts after it. */
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().positive().max(DECISIONS_MAX_LIMIT).optional(),
});

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

/**
 * Every route that has a tenant rule, as {method, path-matcher} pairs.
 *
 * This is the second half of the fail-closed pair `requiredScope` started, and
 * it is separate from it for one reason: forgetting to CLASSIFY a route is a
 * different mistake from forgetting to PROTECT one. A new route is already
 * over-protected by `requiredScope` (it demands `admin`); this table makes it
 * additionally unreachable by any org-scoped key until somebody decides what
 * "your own" means for it. The failure mode that is impossible by
 * construction, then, is the one that matters: a route added later, reachable
 * by a tenant, that returns everybody's rows.
 *
 * `server-auth.test.ts` walks Fastify's own route table and asserts every
 * registered route is listed here — the check that keeps the mirror honest as
 * routes are added.
 */
const TENANT_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  { method: 'GET', path: /^\/health$/ },
  { method: 'POST', path: /^\/v1\/agents$/ },
  { method: 'GET', path: /^\/v1\/agents$/ },
  { method: 'POST', path: /^\/v1\/agents\/[^/]+\/(freeze|unfreeze|heartbeat)$/ },
  { method: 'GET', path: /^\/v1\/agents\/[^/]+\/breakers$/ },
  { method: 'PUT', path: /^\/v1\/agents\/[^/]+\/liveness$/ },
  { method: 'DELETE', path: /^\/v1\/agents\/[^/]+\/liveness$/ },
  { method: 'GET', path: /^\/v1\/liveness$/ },
  { method: 'POST', path: /^\/v1\/policies$/ },
  { method: 'GET', path: /^\/v1\/policies$/ },
  { method: 'POST', path: /^\/v1\/evaluate$/ },
  { method: 'GET', path: /^\/v1\/decisions$/ },
  { method: 'POST', path: /^\/v1\/settlements$/ },
  { method: 'GET', path: /^\/v1\/reconciliation$/ },
  { method: 'POST', path: /^\/v1\/keys$/ },
  { method: 'GET', path: /^\/v1\/keys$/ },
  { method: 'POST', path: /^\/v1\/keys\/[^/]+\/(rotate|revoke)$/ },
  { method: 'POST', path: /^\/v1\/approvers$/ },
  { method: 'GET', path: /^\/v1\/approvers$/ },
  { method: 'POST', path: /^\/v1\/approvers\/[^/]+\/revoke$/ },
  { method: 'GET', path: /^\/v1\/approvals$/ },
  { method: 'GET', path: /^\/v1\/approvals\/[^/]+$/ },
  { method: 'POST', path: /^\/v1\/approvals\/[^/]+\/resolve$/ },
];

/** One entry of the router's own table — see `buildServer`'s `onRoute` hook. */
export interface RegisteredRoute {
  method: string;
  /** The declared path, params included, e.g. `/v1/agents/:id/freeze`. */
  path: string;
}

/** Every route Fastify actually registered on this instance. */
export function registeredRoutes(app: FastifyInstance): RegisteredRoute[] {
  return (app as FastifyInstance & { reinRoutes?: RegisteredRoute[] }).reinRoutes ?? [];
}

/** Does this route know how to confine an org-scoped caller? */
export function tenantRoute(method: string, pathname: string): boolean {
  const m = method === 'HEAD' ? 'GET' : method;
  return TENANT_ROUTES.some((r) => r.method === m && r.path.test(pathname));
}

/**
 * The tenant scope of the request being served, or undefined for an unscoped
 * operator key (and for an engine running without auth at all — the embedded
 * console world and the demos).
 *
 * A WeakMap rather than a property on the request: nothing on the wire can
 * spoof a key that is not a string, the entry dies with the request, and no
 * route can accidentally serialize the scope into a response body.
 */
const SCOPES = new WeakMap<FastifyRequest, TenantScope>();

export function scopeFor(req: FastifyRequest): TenantScope | undefined {
  return SCOPES.get(req);
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
  const app = Fastify({
    logger: false,
    bodyLimit: BODY_LIMIT_BYTES,
    requestTimeout: REQUEST_TIMEOUT_MS,
    trustProxy: options.trustProxy ?? false,
    // On `close()`, destroy sockets rather than waiting for keep-alive
    // connections to go away on their own. A shutdown is not the moment to be
    // patient with a client: the process is leaving, and every second spent
    // waiting on a socket is a second the STORE is not draining — which is the
    // only part of a shutdown that can lose data. Fastify's default ('idle')
    // depends on the runtime offering closeIdleConnections; this does not.
    forceCloseConnections: true,
  });
  const auth = options.auth;
  const limiters = options.rateLimit ? buildRateLimiters(options.rateLimit) : undefined;

  // Fastify's own view of what got registered, captured as it happens. It is
  // what `tenant.test.ts` walks to prove `TENANT_ROUTES` still mirrors the
  // real surface: a route added without a tenant rule is caught by a test
  // reading the router, not by a human remembering to update a list.
  const registeredRoutes: RegisteredRoute[] = [];
  app.addHook('onRoute', (route) => {
    const methods = Array.isArray(route.method) ? route.method : [route.method];
    for (const method of methods) registeredRoutes.push({ method, path: route.url });
  });
  app.decorate('reinRoutes', registeredRoutes);

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
    if (TenantError.is(err)) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    if (err instanceof LivenessError) {
      return reply.status(err.status).send({ error: err.code, message: err.message });
    }
    const message = err instanceof Error ? err.message : String(err);
    // Fastify's OWN refusals — a body over `bodyLimit` (413), an unsupported
    // content type (415), malformed JSON (400) — arrive here as errors
    // carrying their status. Relabelling those 500 would be a lie in the
    // direction that matters: it tells a client the engine broke when in fact
    // the engine refused, and it invites a retry of a request that can only
    // ever fail the same way.
    const status = (err as { statusCode?: unknown }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      const code = (err as { code?: unknown }).code;
      return reply
        .status(status)
        .send({ error: typeof code === 'string' ? code : 'bad_request', message });
    }
    return reply.status(500).send({ error: 'internal_error', message });
  });

  // Auth runs before routing, so an unknown path cannot leak whether it exists.
  // Unauthenticated is 401 with a WWW-Authenticate challenge — never a silent
  // pass, never a 404 pretending the route is missing.
  if (auth || limiters) {
    app.addHook('onRequest', async (req, reply) => {
      const pathname = (req.url ?? '/').split('?')[0] ?? '/';
      // Per IP FIRST, ahead of everything including the credential check: what
      // this bounds is precisely the work a caller who has proved nothing can
      // make the engine do, and `/health` is in scope because it is the
      // cheapest thing on the surface to hammer.
      if (limiters) {
        // `req.ip` reads the socket's remote address (or the proxy header when
        // trustProxy is on) and can be absent on a socket that is already
        // going away. Bucketing those together under one name is right: it is
        // one anonymous pool, not a free pass each.
        const verdict = limiters.perIp.take(req.ip || 'unknown');
        if (!verdict.allowed) return tooManyRequests(reply, verdict.retryAfterSec);
      }
      if (pathname === '/health') return;
      if (!auth) return;
      try {
        const key = auth.authenticate(req.headers, requiredScope(req.method, pathname));
        // Per KEY, and only now: the key id exists once auth has resolved it,
        // and bucketing by the presented secret instead would let one caller
        // mint a fresh allowance per header value it invents.
        if (limiters) {
          const verdict = limiters.perKey.take(key.id);
          if (!verdict.allowed) return tooManyRequests(reply, verdict.retryAfterSec);
        }
        const scope = scopeOf(key);
        if (scope) {
          // Classify before routing, for the same reason authentication runs
          // before routing: a route nobody taught to confine a tenant must be
          // unreachable by one, not reachable-and-unfiltered.
          if (!tenantRoute(req.method, pathname)) {
            throw new AuthError(
              403,
              'route_not_scopable',
              'this route has no tenant rule; it is reachable only by an unscoped key',
            );
          }
          SCOPES.set(req, scope);
        }
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
    const scope = scopeFor(req);
    return engine.registerAgent({
      id: newId('agt'),
      // The caller's org WINS over the body's. A scoped key that asks to
      // register an agent into another org is not refused, it is simply
      // obeyed in its own — there is no legitimate reason for a tenant to
      // name an org at all, and a 400 here would only teach an attacker
      // which org ids exist.
      orgId: resolveOrg(scope, input.orgId),
      name: input.name,
      erc8004Id: input.erc8004Id,
      labels: input.labels ?? [],
      wallets: input.wallets ?? [],
      status: 'active',
      createdAt: new Date(),
    });
  });

  app.get('/v1/agents', (req) => engine.visibleAgents(scopeFor(req)));

  app.post('/v1/agents/:id/freeze', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    engine.requireAgent(id, scopeFor(req));
    await engine.freeze(id);
    return reply.status(204).send();
  });

  app.post('/v1/agents/:id/unfreeze', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    engine.requireAgent(id, scopeFor(req));
    await engine.unfreeze(id);
    return reply.status(204).send();
  });

  // Where the agent's breakers stand right now — read-only observability, so
  // an operator can see WHY an agent is escalating before a challenge lands.
  app.get('/v1/agents/:id/breakers', (req) => {
    const id = (req.params as { id: string }).id;
    engine.requireAgent(id, scopeFor(req));
    return engine.breakerStates(id);
  });

  // --- Dead-man monitoring (B2) ---
  // Declaring an expectation is configuration, so it sits at `admin`; the
  // heartbeat that answers it does not (see requiredScope).
  app.put('/v1/agents/:id/liveness', async (req, reply) => {
    engine.requireAgent((req.params as { id: string }).id, scopeFor(req));
    const input = LivenessWatchInput.parse({
      ...(req.body as object | null ?? {}),
      agentId: (req.params as { id: string }).id,
    });
    return reply.status(201).send(await requireLiveness(engine).watch(input));
  });

  app.delete('/v1/agents/:id/liveness', async (req, reply) => {
    engine.requireAgent((req.params as { id: string }).id, scopeFor(req));
    const removed = await requireLiveness(engine).unwatch((req.params as { id: string }).id);
    return removed ? reply.status(204).send() : reply.status(404).send({ error: 'not_watched' });
  });

  app.post('/v1/agents/:id/heartbeat', async (req, reply) => {
    requireLiveness(engine);
    engine.requireAgent((req.params as { id: string }).id, scopeFor(req));
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

  app.get('/v1/liveness', (req) => engine.visibleLivenessStates(scopeFor(req)));

  // --- Policies ---
  app.post('/v1/policies', (req) => {
    const scope = scopeFor(req);
    const policy = Policy.parse(req.body);
    // Stamped with the caller's org, so a tenant cannot write a GLOBAL policy
    // (`orgId` absent) — which, with the default `appliesTo: {}`, would govern
    // every other tenant's agents.
    return engine.addPolicy(scope ? { ...policy, orgId: scope.orgId } : policy);
  });
  app.get('/v1/policies', (req) => engine.visiblePolicies(scopeFor(req)));

  // --- The hot path ---
  app.post('/v1/evaluate', (req) => {
    const input = IntentInput.parse(req.body);
    const scope = scopeFor(req);
    // 403 rather than 404: the caller is spending, and being told plainly
    // that this agent is not theirs is worth more than hiding whether the id
    // exists. A runtime key narrowed to one agent gets the same answer for
    // every other agent in its own org.
    if (scope && !engine.ownsAgentId(input.agentId, scope)) {
      throw new AuthError(403, 'agent_not_in_scope', 'this API key cannot spend for that agent');
    }
    return engine.evaluateIntent(input);
  });

  // --- Audit ---
  /**
   * The decision chain, one bounded page at a time.
   *
   * The body stays a bare ARRAY of decisions rather than becoming an envelope,
   * which is what lets a 0.2.0 SDK keep parsing this route unchanged — and it
   * gets something better than a truncated list: the first page is a valid
   * VERIFYING PREFIX of the chain, so `prevHash` links still check out end to
   * end. An envelope would have broken every published client for a field they
   * could read off a header instead.
   *
   * Paging state rides in `Rein-Chain-Length` (how many decisions this caller
   * can see in total) and `Rein-Next-After` (present only while more remain —
   * its absence is how a client knows it has reached the head, without having
   * to compare counts).
   */
  app.get('/v1/decisions', (req, reply) => {
    const query = DecisionsQuery.parse(req.query ?? {});
    const visible = engine.decisions(scopeFor(req));
    const start = query.after === undefined ? 0 : query.after + 1;
    const page = visible.slice(start, start + (query.limit ?? DECISIONS_DEFAULT_LIMIT));
    reply.header('Rein-Chain-Length', String(visible.length));
    if (start + page.length < visible.length) {
      reply.header('Rein-Next-After', String(start + page.length - 1));
    }
    // `agentId` rides beside the signed record, never inside it: see
    // AttributedDecision. The scope filter above already limits it to agents
    // the caller owns, so it discloses nothing the page did not.
    return page.map((d) => {
      const agentId = engine.agentOfDecision(d.id);
      return agentId === undefined ? d : { ...d, agentId };
    });
  });

  // --- Reconciliation (B1): allowed but never settled ---
  // The write is the settlement half of the join — see requiredScope for why
  // it sits at `evaluate` rather than `admin`.
  app.post('/v1/settlements', async (req, reply) =>
    reply
      .status(202)
      .send(await engine.recordSettlement(SettlementReport.parse(req.body), scopeFor(req))),
  );

  app.get('/v1/reconciliation', (req) =>
    engine.reconcile(reconcileOptionsFromQuery(req.query), scopeFor(req)),
  );

  // --- API keys (admin scope; see requiredScope) ---
  app.post('/v1/keys', async (req, reply) => {
    const a = requireAuth(auth);
    const input = ApiKeyInput.parse(req.body);
    const scope = scopeFor(req);
    if (scope) {
      // A tenant admin mints inside its own org and nowhere else, and an
      // agent-narrowed key can only mint keys narrower than itself —
      // otherwise the narrowing would be one API call away from undone.
      if (scope.agentIds) {
        const requested = input.agentIds ?? [];
        const outside = requested.filter((id) => !scope.agentIds?.includes(id));
        if (requested.length === 0 || outside.length > 0) {
          throw new AuthError(
            403,
            'agent_not_in_scope',
            'this API key can only issue keys narrowed to its own agents',
          );
        }
      }
    }
    const issued = await a.issue({
      name: input.name,
      scopes: input.scopes,
      ...(scope ? { orgId: scope.orgId } : input.orgId !== undefined ? { orgId: input.orgId } : {}),
      ...(input.agentIds?.length ? { agentIds: input.agentIds } : {}),
    });
    // 201 with the secret in the body: the only time it exists outside the
    // caller's hands. Nothing logs it, and no later read can recover it.
    return reply.status(201).send(issued);
  });

  app.get('/v1/keys', (req) => {
    const scope = scopeFor(req);
    return requireAuth(auth)
      .list()
      .filter((key) => ownsOrg(scope, key.orgId));
  });

  app.post('/v1/keys/:id/rotate', async (req) => {
    const a = requireAuth(auth);
    const id = (req.params as { id: string }).id;
    requireOwnKey(a, id, scopeFor(req));
    const { graceMs } = RotateInput.parse(req.body ?? {});
    return a.rotate(id, { ...(graceMs !== undefined ? { graceMs } : {}) });
  });

  app.post('/v1/keys/:id/revoke', async (req, reply) => {
    const a = requireAuth(auth);
    const id = (req.params as { id: string }).id;
    requireOwnKey(a, id, scopeFor(req));
    const key = await a.revoke(id);
    return key ? key : reply.status(404).send({ error: 'unknown_key_id' });
  });

  // --- Approver keys ---
  app.post('/v1/approvers', async (req, reply) => {
    const input = ApproverInput.parse(req.body);
    const scope = scopeFor(req);
    // Registered into the CALLER's org: an approver is authority over that
    // org's parked payments, and `verify()` refuses a key from another one.
    return reply
      .status(201)
      .send(
        await requireApprovals(engine).registerApprover({
          ...input,
          orgId: resolveOrg(scope, input.orgId),
        }),
      );
  });

  app.get('/v1/approvers', (req) => {
    const scope = scopeFor(req);
    return requireApprovals(engine)
      .listApprovers()
      .filter((key) => ownsOrg(scope, key.orgId));
  });

  app.post('/v1/approvers/:id/revoke', async (req, reply) => {
    const approvals = requireApprovals(engine);
    const id = (req.params as { id: string }).id;
    const scope = scopeFor(req);
    const existing = approvals.getApprover(id);
    if (existing && !ownsOrg(scope, existing.orgId)) {
      return reply.status(404).send({ error: 'unknown_approver' });
    }
    const key = await approvals.revokeApprover(id);
    return key ? key : reply.status(404).send({ error: 'unknown_approver' });
  });

  // --- Escalations awaiting a signature ---
  app.get('/v1/approvals', (req) => {
    requireApprovals(engine);
    return engine.visibleApprovals(scopeFor(req));
  });

  app.get('/v1/approvals/:decisionId', (req, reply) => {
    const approvals = requireApprovals(engine);
    const request = approvals.get((req.params as { decisionId: string }).decisionId);
    if (!request || !ownsOrg(scopeFor(req), request.orgId)) {
      return reply.status(404).send({ error: 'unknown_request' });
    }
    const decision = request.finalDecisionId
      ? findDecision(engine, request.finalDecisionId)
      : undefined;
    // The challenges are derived, not stored — recomputing them here means a
    // client never has to trust its own canonicalization to sign correctly.
    return { request, challenges: approvals.challengesFor(request), ...(decision ? { decision } : {}) };
  });

  app.post('/v1/approvals/:decisionId/resolve', async (req, reply) => {
    const approvals = requireApprovals(engine);
    const decisionId = (req.params as { decisionId: string }).decisionId;
    const parked = approvals.get(decisionId);
    // A foreign escalation is 404, not 403: a scoped caller must not be able
    // to probe which decision ids exist in other orgs. The signature check
    // inside `verify()` is the second gate, and it refuses a foreign approver
    // even on a request this one does reach.
    if (parked && !ownsOrg(scopeFor(req), parked.orgId)) {
      return reply.status(404).send({ error: 'unknown_request' });
    }
    const body = GrantInput.parse(req.body);
    const grant = ApprovalGrant.parse({ decisionId, ...body });
    return engine.resolveEscalation(grant);
  });

  return app;
}

/**
 * A scoped caller may only rotate or revoke keys in its own org, and an
 * agent-narrowed caller only keys narrowed no wider than itself. The answer
 * for a key it cannot reach is the same 404 an unknown id gets, so the key
 * list of another org -- or of the org above its own narrowing -- cannot be
 * enumerated one id at a time.
 *
 * The second rule is the one this used to be missing. `POST /v1/keys` already
 * refuses to MINT a key wider than the caller, "otherwise the narrowing would
 * be one API call away from undone" -- and rotate was that one API call: it
 * returns the replacement plaintext secret, so a key narrowed to one agent
 * could rotate its own org's un-narrowed admin key and read the new secret out
 * of the response. Revoke was the same hole pointed the other way.
 */
function requireOwnKey(auth: ApiKeyAuth, keyId: string, scope: TenantScope | undefined): void {
  if (!scope) return;
  const key = auth.get(keyId);
  if (!key || !ownsOrg(scope, key.orgId)) {
    throw new TenantError(404, 'not_found', `no such key: ${keyId}`);
  }
  if (!scope.agentIds) return;
  const target = key.agentIds ?? [];
  const wider = target.length === 0 || target.some((id) => !scope.agentIds?.includes(id));
  if (wider) {
    throw new TenantError(404, 'not_found', `no such key: ${keyId}`);
  }
}

/**
 * Which org a write lands in: the caller's when it has one, the body's when it
 * is an unscoped operator key. An operator that names none is a 400 — an agent
 * or an approver with no org is exactly the unattributed row that later has to
 * be hidden from every tenant.
 */
function resolveOrg(scope: TenantScope | undefined, requested: string | undefined): string {
  if (scope) return scope.orgId;
  if (requested === undefined) {
    throw new z.ZodError([
      {
        code: 'invalid_type',
        expected: 'string',
        received: 'undefined',
        path: ['orgId'],
        message: 'orgId is required for an unscoped key',
      },
    ]);
  }
  return requested;
}

/**
 * The one refusal that is about capacity rather than authority.
 *
 * `Retry-After` is not decoration: without it a client's only strategy is to
 * retry immediately, which is exactly the behaviour the 429 is trying to stop.
 * The SDK reads it, and `PaymentBlockedError` never wraps this — a throttled
 * request was not judged, so treating it as a denial would report a policy
 * verdict that policy never reached.
 */
function tooManyRequests(reply: FastifyReply, retryAfterSec: number): FastifyReply {
  return reply
    .header('Retry-After', String(retryAfterSec))
    .status(429)
    .send({
      error: 'rate_limited',
      message: `too many requests; retry in ${retryAfterSec}s`,
    });
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

/**
 * The peer addresses whose `X-Forwarded-For` this engine believes, for a proxy
 * that reaches it over the provider's internal network — which is every managed
 * platform, Railway included. `uniquelocal` is proxy-addr's name for the
 * private ranges (10/8, 172.16/12, 192.168/16, fc00::/7).
 */
const PRIVATE_PEERS = 'loopback,linklocal,uniquelocal';

/** A single trust entry: a proxy-addr preset, or an IP / CIDR. */
const TRUST_ENTRY = /^(?:loopback|linklocal|uniquelocal|[0-9a-f.:]+(?:\/[0-9]+)?)$/;

/**
 * `REIN_TRUST_PROXY` as a trust SPEC — see {@link ServerOptions.trustProxy}.
 *
 * `1` is the deployed value and keeps working, now meaning `private`: trust a
 * proxy that reached us from inside the network. It was read as a boolean until
 * 2026-09-17, which trusted the left-most `X-Forwarded-For` entry — the one the
 * CLIENT writes — so self-hosters keep their string and stop being forgeable.
 *
 * A HOP COUNT is refused, and the refusal is the interesting part: fastify 5
 * compiles a numeric `trustProxy` to "trust nothing" on purpose, because
 * counting hops cannot tell you WHO the immediate peer is, so a direct client
 * could supply enough hops to look proxied. Accepting `2` here would therefore
 * be silently equivalent to off, and off behind a proxy means every caller in
 * the world shares one rate-limit bucket. Measured, not read: `trustProxy: 1`
 * and `trustProxy: 2` both left `req.ip` as the socket address.
 *
 * An unrecognised value THROWS rather than falling back to off, for the reason
 * {@link rateLimitFromEnv} refuses to guess: an operator who set this meant to
 * configure a proxy, and starting anyway would leave them believing the per-IP
 * limiter buckets by client when it buckets every caller as one.
 */
export function parseTrustProxy(raw: string | undefined): boolean | string {
  const value = raw?.trim().toLowerCase();
  if (!value || value === '0' || value === 'off' || value === 'false' || value === 'no') {
    return false;
  }
  if (value === '1' || value === 'private') return PRIVATE_PEERS;
  // Deliberately reachable, and deliberately not the meaning of `1`: a chain
  // whose peers cannot be named needs an escape hatch, and spelling it `all`
  // makes a forgeable choice legible in a dashboard instead of hiding it in a
  // digit. The per-IP limiter is a no-op under it.
  if (value === 'all') return true;
  if (/^[0-9]+$/.test(value)) {
    throw new Error(
      `REIN_TRUST_PROXY=${raw} looks like a hop count, and fastify refuses those.\n` +
        '  A count cannot identify the peer, so it is compiled to "trust nothing" —\n' +
        '  which behind a proxy puts every caller in ONE rate-limit bucket.\n' +
        '  Use 1 (or `private`) for a proxy on the internal network, or name its IP/CIDR.',
    );
  }
  const entries = value.split(',').map((entry) => entry.trim());
  if (entries.every((entry) => TRUST_ENTRY.test(entry))) return entries.join(',');
  throw new Error(
    `REIN_TRUST_PROXY=${raw} is not a trust spec.\n` +
      '  Use 1 / private for a proxy on the internal network (Railway), an IP or\n' +
      '  CIDR list naming it, 0 / off for no proxy, or `all` to trust a header\n' +
      '  any client can forge.',
  );
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
  const stops = [
    engine.startExpirySweeper(),
    // Nothing else will ever call the engine about an agent that stopped.
    engine.startLivenessSweeper(),
  ];
  // A bin is reachable by strangers, so it gets the limiter an embedded engine
  // has no use for. REIN_TRUST_PROXY is the number of proxies in front of it —
  // see ServerOptions.trustProxy for why a count and not a flag.
  const rateLimit = rateLimitFromEnv(process.env);
  const app = buildServer(engine, {
    ...(auth ? { auth } : {}),
    ...(rateLimit ? { rateLimit } : {}),
    trustProxy: parseTrustProxy(process.env['REIN_TRUST_PROXY']),
  });
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

  // Graceful shutdown. This engine holds everything in memory, so there is no
  // tail to flush and nothing here can lose data that a restart would not lose
  // anyway — which is exactly why it is four lines rather than the durable
  // bins' `installShutdown` (services/store/src/lifecycle.ts, which this
  // package cannot import: store depends on policy-engine, not the reverse).
  // What it buys is a clean exit code and sweepers that stop, instead of a
  // process torn down mid-response.
  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    console.log(`[rein] policy-engine: ${signal} received — closing (in-memory state is not saved)`);
    for (const stop of stops) stop();
    void app.close().then(
      () => {
        process.exitCode = 0;
      },
      (err: unknown) => {
        console.error('[rein] policy-engine: close failed:', err);
        process.exitCode = 1;
      },
    );
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
