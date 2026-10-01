import type { ApiKey } from '@reinconsole/core';
import type { ApiKeyAuth } from '@reinconsole/core/auth';
import type { PolicyEngine } from './engine.js';
import { OWNER_KEY_PREFIX, SESSION_KEY_PREFIX } from './claims.js';
import { SANDBOX_KEY_NAME } from './sandbox.js';

/**
 * The hosted engine's tenancy sweep: rows that anonymous sign-up and sign-in
 * create, and that nothing would otherwise ever remove.
 *
 * - **Owner session keys.** Every console sign-in mints a 12 h `session:` key
 *   (claims.ts) -- about one row per owner per sign-in, forever. Deleted a day
 *   after they expire.
 * - **Dead sandboxes.** An unclaimed sandbox org is unreachable once its keys
 *   expire (sandbox.ts: the key IS the sandbox). Its agents, policies and keys
 *   go a month after the LAST of its keys expired.
 *
 * What is NOT removed, and why:
 * - **Decisions, spend and settlements.** Hash-linked; the chain cannot lose a
 *   row. A reaped agent's decisions become unattributed, which already means
 *   "shown to unscoped operators only" (tenant.ts) -- the right audience for
 *   an org nobody can sign in to.
 * - **Any org that is not provably a dead sandbox.** It must hold a key named
 *   {@link SANDBOX_KEY_NAME}, no `owner:` key (revoked or not), and EVERY one
 *   of its keys must have expired more than the grace ago. A claimed org has
 *   permanent keys; a self-hoster's org that merely uses expiring keys has no
 *   `sandbox` key -- neither can match.
 *
 * The month of grace is so `init --claim` on a lapsed sandbox still answers
 * `key_expired`, which says what happened, rather than `invalid_key`.
 *
 * Order within an org is policies, agents, keys: the keys are what mark the
 * org as a sandbox, so a sweep that dies halfway is finished by the next one.
 */

export const DEFAULT_SESSION_KEY_GRACE_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_SANDBOX_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
export const DEFAULT_REAP_INTERVAL_MS = 30 * 60 * 1000;

export interface ReapOptions {
  /** Reap dead sandbox orgs as well as session keys. The bin passes true when `REIN_SANDBOX=1`. */
  sandboxes?: boolean;
  sessionGraceMs?: number;
  sandboxGraceMs?: number;
  now?: () => number;
}

export interface ReapResult {
  sessionKeys: number;
  orgs: number;
  agents: number;
  policies: number;
  keys: number;
}

export async function reapExpired(
  engine: PolicyEngine,
  auth: ApiKeyAuth,
  options: ReapOptions = {},
): Promise<ReapResult> {
  const now = (options.now ?? Date.now)();
  const sessionCutoff = now - (options.sessionGraceMs ?? DEFAULT_SESSION_KEY_GRACE_MS);
  const sandboxCutoff = now - (options.sandboxGraceMs ?? DEFAULT_SANDBOX_GRACE_MS);
  const result: ReapResult = { sessionKeys: 0, orgs: 0, agents: 0, policies: 0, keys: 0 };
  const lapsedBefore = (key: ApiKey, cutoff: number) =>
    key.expiresAt !== undefined && key.expiresAt.getTime() <= cutoff;

  for (const key of auth.list()) {
    if (key.name.startsWith(SESSION_KEY_PREFIX) && lapsedBefore(key, sessionCutoff)) {
      if (await auth.remove(key.id)) result.sessionKeys += 1;
    }
  }
  if (!options.sandboxes) return result;

  const byOrg = new Map<string, ApiKey[]>();
  for (const key of auth.list()) {
    if (key.orgId === undefined) continue;
    byOrg.set(key.orgId, [...(byOrg.get(key.orgId) ?? []), key]);
  }
  for (const [orgId, keys] of byOrg) {
    const dead =
      keys.some((k) => k.name === SANDBOX_KEY_NAME) &&
      !keys.some((k) => k.name.startsWith(OWNER_KEY_PREFIX)) &&
      keys.every((k) => lapsedBefore(k, sandboxCutoff));
    if (!dead) continue;
    for (const policy of engine.policies.list().filter((p) => p.orgId === orgId)) {
      await engine.policies.remove(policy.policyId);
      result.policies += 1;
    }
    for (const agent of engine.agents.list().filter((a) => a.orgId === orgId)) {
      if (engine.liveness?.watches(agent.id)) await engine.unwatchLiveness(agent.id);
      await engine.agents.remove(agent.id);
      result.agents += 1;
    }
    for (const key of keys) {
      if (await auth.remove(key.id)) result.keys += 1;
    }
    result.orgs += 1;
  }
  return result;
}
