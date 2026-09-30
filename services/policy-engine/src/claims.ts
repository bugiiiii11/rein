import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { ApiKey } from '@reinconsole/core';
import type { ApiKeyAuth } from '@reinconsole/core/auth';

/**
 * Claiming a sandbox (Stage 4, Sprint 13): one sign-in keeps an anonymous
 * sandbox org -- its keys stop expiring, its quotas lift -- and binds it to an
 * identity the hosted console can sign in.
 *
 * Three steps, and each holds a different credential:
 *
 * 1. `POST /v1/claims` with the sandbox's own admin key (what `init --claim`
 *    holds in `rein-agent.json`) mints a one-time code, good for ten minutes.
 *    Only the org's own key can start its claim, so knowing an org id is worth
 *    nothing.
 * 2. The browser carries the code to the console, the person signs in there
 *    (GitHub or Ethereum), and the console calls `POST /v1/claims/redeem` with
 *    the code and the identity it verified. That call needs the `identity`
 *    scope on an UNSCOPED key -- the console's -- because the engine does not
 *    run sign-in itself and has to trust someone to say who signed in.
 * 3. On every later sign-in the console calls `POST /v1/owners/session` and
 *    gets a short-lived org-scoped `read` key: the dashboard shows the owner's
 *    org through the same tenant filter every other key goes through, and the
 *    console never holds anything that reads more than one org.
 *
 * The binding is stored as a key, not a table: an `owner:<identity>` key in
 * the claimed org whose secret was discarded at issuance, so it can never
 * authenticate. The key store already persists on both backends, the org's
 * own admin sees its owner in `GET /v1/keys`, and revoking that key is how an
 * org is released. One identity owns at most one org; one org has at most one
 * owner.
 *
 * Pending codes live in memory. A restart forgets them, which costs a person
 * one re-run of `init --claim` -- cheaper than a table of short-lived bearer
 * codes that would have to be pruned.
 */

export const OWNER_KEY_PREFIX = 'owner:';
export const SESSION_KEY_PREFIX = 'session:';
export const DEFAULT_CLAIM_CODE_TTL_MS = 10 * 60 * 1000;
export const DEFAULT_OWNER_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/**
 * Who signed in, as the console verified it. GitHub by numeric user id (a
 * login can be renamed and then re-registered by somebody else), Ethereum by
 * lowercase address.
 */
export const Identity = z
  .string()
  .regex(/^(github:[0-9]{1,20}|eth:0x[0-9a-f]{40})$/, 'identity must be github:<id> or eth:<lowercase address>');

export const RedeemInput = z.object({
  code: z.string().min(1).max(200),
  identity: Identity,
});

export const SessionInput = z.object({ identity: Identity });

export class ClaimError extends Error {
  constructor(
    readonly status: 400 | 403 | 404 | 409,
    readonly code:
      | 'claim_needs_org_admin'
      | 'already_claimed'
      | 'identity_has_org'
      | 'unknown_claim_code'
      | 'not_an_owner',
    message: string,
  ) {
    super(message);
    this.name = 'ClaimError';
  }
}

export interface ClaimOptions {
  codeTtlMs?: number;
  sessionTtlMs?: number;
  now?: () => number;
}

export interface ClaimStarted {
  code: string;
  orgId: string;
  expiresAt: string;
}

export interface ClaimRedeemed {
  orgId: string;
  identity: string;
  /** How many of the org's keys stopped expiring. */
  lifted: number;
  /** True when this identity already owned this org -- a repeated redeem is not an error. */
  alreadyOwned: boolean;
}

export interface OwnerSession {
  orgId: string;
  apiKey: string;
  expiresAt: string;
}

/** Keys whose names the engine reserves -- `POST /v1/keys` refuses to mint them. */
export function reservedKeyName(name: string): boolean {
  return name.startsWith(OWNER_KEY_PREFIX) || name.startsWith(SESSION_KEY_PREFIX);
}

export class ClaimService {
  private readonly codes = new Map<string, { orgId: string; expiresAt: number }>();
  private readonly codeTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly now: () => number;
  /** Redeems one at a time, so two identities cannot both win the same org. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly auth: ApiKeyAuth,
    options: ClaimOptions = {},
  ) {
    this.codeTtlMs = options.codeTtlMs ?? DEFAULT_CLAIM_CODE_TTL_MS;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_OWNER_SESSION_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** The org an identity owns, if any. */
  ownedBy(identity: string): string | undefined {
    return this.owners().find((k) => k.name === OWNER_KEY_PREFIX + identity)?.orgId;
  }

  /** The identity that owns an org, if any. */
  ownerOf(orgId: string): string | undefined {
    return this.owners()
      .find((k) => k.orgId === orgId)
      ?.name.slice(OWNER_KEY_PREFIX.length);
  }

  start(caller: ApiKey): ClaimStarted {
    // Org-wide admin only: an agent-narrowed key is what a runtime carries,
    // and handing the whole org to whoever holds one would undo the narrowing.
    if (caller.orgId === undefined || caller.agentIds?.length || !caller.scopes.includes('admin')) {
      throw new ClaimError(
        403,
        'claim_needs_org_admin',
        'start a claim with the org-wide admin key the sandbox issued (rein-agent.json)',
      );
    }
    if (this.ownerOf(caller.orgId) !== undefined) {
      throw new ClaimError(409, 'already_claimed', 'this org is already claimed');
    }
    this.sweep();
    // One live code per org: a new one replaces the old.
    for (const [code, entry] of this.codes) if (entry.orgId === caller.orgId) this.codes.delete(code);
    const code = randomBytes(24).toString('base64url');
    const expiresAt = this.now() + this.codeTtlMs;
    this.codes.set(code, { orgId: caller.orgId, expiresAt });
    return { code, orgId: caller.orgId, expiresAt: new Date(expiresAt).toISOString() };
  }

  redeem(body: unknown): Promise<ClaimRedeemed> {
    const input = RedeemInput.parse(body);
    const run = this.chain.then(() => this.bind(input.code, input.identity));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async bind(code: string, identity: string): Promise<ClaimRedeemed> {
    this.sweep();
    const entry = this.codes.get(code);
    if (!entry) {
      throw new ClaimError(404, 'unknown_claim_code', 'this claim link has expired or was already used; run `npx @reinconsole/init --claim` again');
    }
    const { orgId } = entry;
    const owned = this.ownedBy(identity);
    if (owned === orgId) {
      this.codes.delete(code);
      return { orgId, identity, lifted: 0, alreadyOwned: true };
    }
    if (owned !== undefined) {
      throw new ClaimError(409, 'identity_has_org', 'this account already owns an org; one org per account');
    }
    if (this.ownerOf(orgId) !== undefined) {
      this.codes.delete(code);
      throw new ClaimError(409, 'already_claimed', 'this org is already claimed');
    }
    // The code is spent before anything is written: a failure below leaves an
    // org half-lifted at worst, never a code that can be replayed.
    this.codes.delete(code);
    await this.auth.issue({ name: OWNER_KEY_PREFIX + identity, scopes: ['read'], orgId });
    let lifted = 0;
    for (const key of this.auth.list()) {
      if (key.orgId !== orgId || key.expiresAt === undefined || key.revokedAt) continue;
      if (key.name.startsWith(SESSION_KEY_PREFIX)) continue;
      await this.auth.clearExpiry(key.id);
      lifted += 1;
    }
    return { orgId, identity, lifted, alreadyOwned: false };
  }

  /** A short-lived read key for the owner's org -- what the console renders with. */
  async session(body: unknown): Promise<OwnerSession> {
    const { identity } = SessionInput.parse(body);
    const orgId = this.ownedBy(identity);
    if (orgId === undefined) {
      throw new ClaimError(404, 'not_an_owner', 'this identity has not claimed an org');
    }
    const expiresAt = new Date(this.now() + this.sessionTtlMs);
    const issued = await this.auth.issue({
      name: SESSION_KEY_PREFIX + identity,
      scopes: ['read'],
      orgId,
      expiresAt,
    });
    return { orgId, apiKey: issued.secret, expiresAt: expiresAt.toISOString() };
  }

  private owners(): ApiKey[] {
    return this.auth
      .list()
      .filter((k) => k.name.startsWith(OWNER_KEY_PREFIX) && !k.revokedAt && k.orgId !== undefined);
  }

  private sweep(): void {
    const now = this.now();
    for (const [code, entry] of this.codes) if (entry.expiresAt <= now) this.codes.delete(code);
  }
}
