import { z } from 'zod';
import { newId, type ApiKey } from '@reinconsole/core';
import type { ApiKeyAuth } from '@reinconsole/core/auth';
import type { PolicyEngine } from './engine.js';
import { TokenBucketLimiter } from './rate-limit.js';

/**
 * The anonymous sandbox (Stage 4, Sprint 12): `POST /v1/sandbox` mints a
 * throwaway org -- one agent, a starter policy, one org-scoped key -- with no
 * account, so `npx @reinconsole/init` can reach a governed payment and a
 * denial before anybody has signed up for anything.
 *
 * Three limits bound what an unauthenticated caller can make this do, and they
 * are layered on purpose:
 * - **per IP** (in memory): a handful per day, so one laptop cannot farm orgs;
 * - **per day, globally** (durable -- counted from the keys the sandbox has
 *   issued, which survive a restart): the ceiling on total cost, including the
 *   test USDC the drip hands out;
 * - **per key**: every sandbox key EXPIRES, and a key it mints inherits the
 *   deadline (see `POST /v1/keys`), so nothing minted here outlives the week.
 *
 * The sandbox is recognised by its key name, {@link SANDBOX_KEY_NAME}: no
 * separate table, because the key IS the sandbox -- when it expires the org is
 * unreachable, and claiming it (Sprint 13) is lifting that expiry.
 */

export const SANDBOX_KEY_NAME = 'sandbox';
export const DEFAULT_SANDBOX_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SANDBOX_DAILY_CAP = 200;
export const DEFAULT_SANDBOX_PER_IP_PER_DAY = 5;
/** Agents one sandbox org may register -- the starter one plus a couple. */
export const DEFAULT_SANDBOX_MAX_AGENTS = 3;
/** Decisions per sandbox org per rolling 24h -- the chain is append-only, so rows need a cap too. */
export const DEFAULT_SANDBOX_MAX_DECISIONS_PER_DAY = 500;

/**
 * The starter policy. Priced against the reference vendor's testnet lane:
 * `/testnet/v1/ping` ($0.001) passes, `/testnet/v1/scores/...` ($0.005) is
 * refused by the per-call cap -- one call each way is the whole first-run
 * demo. The daily budget bounds a runaway loop at five cents of test USDC.
 */
export function starterPolicy(orgId: string, agentId: string) {
  return {
    policyId: `pol_sandbox_${agentId.slice(4).toLowerCase()}`,
    orgId,
    appliesTo: { agents: [agentId] },
    rules: [
      { id: 'per-call-cap', deny: { amountGt: '0.004' } },
      { id: 'daily-budget', deny: { rollingSum: { window: '24h', gt: '0.05' } } },
    ],
    default: 'allow' as const,
  };
}

/** Test USDC for the agent's fresh wallet. Configured only where a faucet exists. */
export type SandboxDrip = (address: `0x${string}`) => Promise<{ txHash: string; amount: string }>;

export interface SandboxOptions {
  ttlMs?: number;
  dailyCap?: number;
  perIpPerDay?: number;
  maxAgents?: number;
  maxDecisionsPerDay?: number;
  drip?: SandboxDrip;
  now?: () => number;
}

export const SandboxInput = z.object({
  /** The agent's own wallet, generated on the caller's machine. Optional: without it there is no drip. */
  wallet: z
    .string()
    .regex(/^0x[0-9a-fA-F]{40}$/, 'wallet must be a 0x-prefixed 20-byte address')
    .optional(),
  name: z.string().min(1).max(100).optional(),
});

export interface SandboxCreated {
  orgId: string;
  agentId: string;
  policyId: string;
  apiKey: string;
  expiresAt: string;
  /** Present when a drip was configured and a wallet was given. */
  drip?: { txHash: string; amount: string } | { error: string };
}

export class SandboxError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSec?: number,
  ) {
    super(message);
  }
}

export class SandboxService {
  private readonly ttlMs: number;
  private readonly dailyCap: number;
  private readonly maxAgents: number;
  private readonly maxDecisions: number;
  private readonly perIp: TokenBucketLimiter;
  private readonly now: () => number;
  /** Mints one at a time, so the global count cannot be raced past its cap. */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly engine: PolicyEngine,
    private readonly auth: ApiKeyAuth,
    private readonly options: SandboxOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SANDBOX_TTL_MS;
    this.dailyCap = options.dailyCap ?? DEFAULT_SANDBOX_DAILY_CAP;
    this.maxAgents = options.maxAgents ?? DEFAULT_SANDBOX_MAX_AGENTS;
    this.maxDecisions = options.maxDecisionsPerDay ?? DEFAULT_SANDBOX_MAX_DECISIONS_PER_DAY;
    this.now = options.now ?? Date.now;
    const perDay = options.perIpPerDay ?? DEFAULT_SANDBOX_PER_IP_PER_DAY;
    this.perIp = new TokenBucketLimiter({ capacity: perDay, refillPerSec: perDay / 86_400 });
  }

  /** True for a key the sandbox issued, or one minted from it. */
  static isSandboxKey(key: Pick<ApiKey, 'expiresAt'>): boolean {
    return key.expiresAt !== undefined;
  }

  /** How many agents a sandbox org may hold (enforced by `POST /v1/agents`). */
  get agentQuota(): number {
    return this.maxAgents;
  }

  /** Decisions a sandbox org may make per rolling 24h (enforced by `POST /v1/evaluate`). */
  get decisionQuota(): number {
    return this.maxDecisions;
  }

  create(ip: string, body: unknown): Promise<SandboxCreated> {
    const input = SandboxInput.parse(body ?? {});
    const run = this.chain.then(() => this.mint(ip, input));
    this.chain = run.catch(() => undefined);
    return run;
  }

  private async mint(ip: string, input: z.infer<typeof SandboxInput>): Promise<SandboxCreated> {
    const now = this.now();
    const since = now - 86_400_000;
    const today = this.auth
      .list()
      .filter((k) => k.name === SANDBOX_KEY_NAME && k.createdAt.getTime() >= since).length;
    if (today >= this.dailyCap) {
      throw new SandboxError(
        503,
        'sandbox_capacity',
        'the sandbox has handed out all of today\'s orgs; try again tomorrow or self-host: https://reinconsole.com/run-rein-locally',
      );
    }
    const ipVerdict = this.perIp.take(ip, now);
    if (!ipVerdict.allowed) {
      throw new SandboxError(
        429,
        'sandbox_rate_limited',
        'too many sandboxes from this address today',
        ipVerdict.retryAfterSec,
      );
    }

    const orgId = newId('org');
    const agent = await this.engine.registerAgent({
      id: newId('agt'),
      orgId,
      name: input.name ?? 'sandbox-agent',
      labels: ['sandbox'],
      wallets: input.wallet ? [{ chain: 'base', address: input.wallet, mode: 'sdk' }] : [],
      status: 'active',
      createdAt: new Date(now),
    });
    const policy = await this.engine.addPolicy(starterPolicy(orgId, agent.id));
    const expiresAt = new Date(now + this.ttlMs);
    // admin INSIDE its own org: the point of a sandbox is to change the policy
    // and watch the verdict change. Confined by org scope, capped by quotas,
    // and dead in a week.
    const issued = await this.auth.issue({
      name: SANDBOX_KEY_NAME,
      scopes: ['admin', 'read', 'evaluate'],
      orgId,
      expiresAt,
    });

    const created: SandboxCreated = {
      orgId,
      agentId: agent.id,
      policyId: policy.policyId,
      apiKey: issued.secret,
      expiresAt: expiresAt.toISOString(),
    };
    if (this.options.drip && input.wallet) {
      // A failed drip does not fail the sandbox: the org is real and the
      // advisory path works without money. The caller is told why.
      try {
        created.drip = await this.options.drip(input.wallet as `0x${string}`);
      } catch (err) {
        created.drip = { error: err instanceof Error ? err.message : String(err) };
      }
    }
    return created;
  }
}

/** The bin's sandbox settings. Off unless `REIN_SANDBOX=1`. */
export function sandboxOptionsFromEnv(env: NodeJS.ProcessEnv): SandboxOptions | undefined {
  if (env['REIN_SANDBOX'] !== '1') return undefined;
  const num = (name: string): number | undefined => {
    const raw = env[name];
    if (raw === undefined || raw === '') return undefined;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new TypeError(`${name} must be a positive number`);
    return n;
  };
  const dailyCap = num('REIN_SANDBOX_DAILY_CAP');
  const perIpPerDay = num('REIN_SANDBOX_PER_IP_PER_DAY');
  const ttlDays = num('REIN_SANDBOX_TTL_DAYS');
  return {
    ...(dailyCap !== undefined ? { dailyCap } : {}),
    ...(perIpPerDay !== undefined ? { perIpPerDay } : {}),
    ...(ttlDays !== undefined ? { ttlMs: ttlDays * 86_400_000 } : {}),
  };
}
