import type { Agent, ApiKey, Policy } from '@reinconsole/core';
import { AuthError } from '@reinconsole/core/auth';

/**
 * Tenant isolation: what one API key is allowed to see and touch.
 *
 * The rule the whole design rests on, and the reason it was safe to ship on a
 * live deployment: a key with no `orgId` is an UNSCOPED OPERATOR key, and
 * every function here returns "yes, everything" for it. Self-hosters, the
 * env-seeded boot secrets and every key issued before tenants existed carry no
 * org, so their behaviour is byte-identical to before. Isolation is something
 * a key opts into by being issued with an org, not something that silently
 * changed underneath anyone.
 *
 * The second rule is that scoping is applied where the DATA is, not where the
 * route is: a route may forget to filter, but a scoped read that never sees a
 * foreign row cannot leak one. The route layer's job is to refuse what it
 * cannot classify (see `tenantRoute` in server.ts) and to stamp writes with
 * the caller's org rather than the org the body asked for.
 */
export type TenantFailureCode =
  /** A policy id already exists, and it belongs to somebody else. */
  | 'policy_id_taken'
  /** The caller's scope does not contain the agent the call names. */
  | 'agent_not_in_scope'
  /** The object exists, but not for this caller — answered as a 404. */
  | 'not_found';

/**
 * A refused cross-tenant operation. Separate from {@link AuthError} because
 * the credential is fine: this is the same key being told that the OBJECT is
 * not its own.
 */
export class TenantError extends Error {
  constructor(
    readonly status: 403 | 404 | 409,
    readonly code: TenantFailureCode,
    message: string,
  ) {
    super(message);
    this.name = 'TenantError';
  }

  /** Cross-package safe, for the same bundling reason as `AuthError.is`. */
  static is(err: unknown): err is TenantError {
    return (
      err instanceof TenantError ||
      (typeof err === 'object' &&
        err !== null &&
        (err as { name?: unknown }).name === 'TenantError')
    );
  }
}

export interface TenantScope {
  /** The org every read and write is confined to. */
  readonly orgId: string;
  /**
   * When present, a further narrowing to named agents — what an agent runtime
   * carries, so a stolen key spends one agent's budget and not the org's.
   * Absent means every agent in the org.
   */
  readonly agentIds?: readonly string[];
}

/**
 * The scope a credential implies, or `undefined` for an unscoped operator key.
 *
 * The defensive throw is for a shape that {@link ApiKeyAuth.issue} refuses to
 * mint: agent narrowing with no org. Were such a row to reach here (a
 * hand-edited database, a future writer that skips `issue`), treating it as
 * unscoped would promote the most confined key in the system to the least
 * confined one. It fails closed instead.
 */
export function scopeOf(key: Pick<ApiKey, 'orgId' | 'agentIds'>): TenantScope | undefined {
  if (key.orgId === undefined) {
    if (key.agentIds?.length) {
      throw new AuthError(
        403,
        'route_not_scopable',
        'API key names agents but no org; it cannot be scoped',
      );
    }
    return undefined;
  }
  return {
    orgId: key.orgId,
    ...(key.agentIds?.length ? { agentIds: key.agentIds } : {}),
  };
}

/**
 * May this scope act on this agent?
 *
 * An UNREGISTERED agent (`undefined`) is never owned by a scoped caller. That
 * is deliberate and it is the fail-closed direction: the agent document is the
 * only thing that says which org an agent belongs to, so an unknown agent has
 * no org, and "no org" must not read as "any org". An unscoped operator key
 * still reaches it, which is what keeps registering-by-first-intent working on
 * a single-tenant deployment.
 */
export function ownsAgent(scope: TenantScope | undefined, agent: Agent | undefined): boolean {
  if (!scope) return true;
  if (!agent || agent.orgId !== scope.orgId) return false;
  return scope.agentIds === undefined || scope.agentIds.includes(agent.id);
}

/** Same question, by id, for callers that hold a registry rather than a document. */
export function ownsAgentId(
  scope: TenantScope | undefined,
  agentId: string,
  lookup: (id: string) => Agent | undefined,
): boolean {
  return scope === undefined ? true : ownsAgent(scope, lookup(agentId));
}

/**
 * Which policies are candidates for an agent: the global ones plus the ones
 * written for the agent's own org.
 *
 * This runs INSIDE evaluation, not only on the list route, and that is the
 * point. `appliesTo: {}` matches every agent, so the first policy a new tenant
 * writes would otherwise start governing every other tenant's payments — a
 * cross-tenant authority leak dressed as a default. Org scoping is applied
 * before targeting, so a foreign policy is never a candidate at all.
 *
 * An unregistered agent has no org and therefore sees only global policies,
 * which is exactly what it saw before tenancy existed.
 */
export function visiblePolicies(policies: readonly Policy[], agent: Agent | undefined): Policy[] {
  return policies.filter((p) => p.orgId === undefined || p.orgId === agent?.orgId);
}

/** Which policies a CALLER may read: global ones, plus its own org's. */
export function readablePolicies(
  policies: readonly Policy[],
  scope: TenantScope | undefined,
): Policy[] {
  if (!scope) return [...policies];
  return policies.filter((p) => p.orgId === undefined || p.orgId === scope.orgId);
}

/**
 * Whether a row stamped with `orgId` is visible to this scope.
 *
 * An UNSTAMPED row (`undefined`) is visible only to an unscoped caller. Rows
 * written before tenancy have no org, and showing them to whichever tenant
 * asked first would be the migration turning into a leak.
 */
export function ownsOrg(scope: TenantScope | undefined, orgId: string | undefined): boolean {
  if (!scope) return true;
  return orgId !== undefined && orgId === scope.orgId;
}
