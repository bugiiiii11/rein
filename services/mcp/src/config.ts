import { AgentId } from '@reinconsole/core';
import type { Payer } from '@reinconsole/sdk';

/**
 * How the MCP server is wired. Everything here is fixed at startup and none of
 * it is reachable from a tool call -- the harness on the other end of the pipe
 * is the AGENT, the thing being governed, so it must not be able to re-point
 * the engine, swap its own agent id, or attach a payer.
 */
export interface ReinMcpConfig {
  /** Policy engine base URL, e.g. "http://127.0.0.1:8787". */
  engineUrl: string;
  /** API-key secret for the engine. Any engine started with one demands it. */
  apiKey?: string;
  /**
   * The ONE agent this server speaks for. Never a tool parameter: an agent id
   * the caller could choose would turn an agent-scoped tool surface into a
   * cross-agent admin API, readable by whoever holds the pipe.
   */
  agentId: string;
  /**
   * Settles allowed payments. Absent = ADVISORY mode: a paywall is evaluated
   * and reported, and nothing is ever paid. That is the honest default for a
   * server that runs inside someone else's harness -- a key has to be handed
   * over deliberately, not acquired by installing an MCP server.
   */
  payer?: Payer;
  /**
   * How long `rein_fetch` may hold a tool call open waiting for a signed
   * verdict on an escalation. 0 (the default) returns immediately with the
   * parked request: an escalation TTL is measured in hours and a harness's
   * tool timeout in seconds, so waiting is the exception, not the rule. The
   * agent polls `rein_escalations` instead, or does something else.
   */
  escalationWaitMs?: number;
  /**
   * Cap on the response body handed back to the model. A tool result goes
   * straight into the context window, so an unbounded body is a context bomb
   * the agent pays for twice. Truncation is ANNOUNCED in the result -- silently
   * shortening a payload the agent paid for would be the worse failure.
   */
  maxBodyBytes?: number;
  /** Task attribution applied to every intent (A4 budgets). Overridable per call. */
  taskId?: string;
  /** Vendor-facing fetch. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch;
  /**
   * Which network this server pays on: `testnet` (the default) or `mainnet`.
   * It bounds both the guard and the payer, so a 402 offering only the other
   * network fails closed instead of being signed for.
   */
  networkProfile?: McpProfileName;
}

export type McpProfileName = 'testnet' | 'mainnet';

/**
 * The x402 network ids each profile covers, in both dialects.
 *
 * Deliberately a LOCAL copy of what `@reinconsole/x402-rails` profiles.ts
 * declares, rather than an import: that module pulls viem in behind it, and
 * the whole point of the dynamic payer import below is that an advisory
 * install never loads a signing stack. These are plain strings and drift is
 * the obvious risk, so `config.test.ts` pins them against the real profiles --
 * the test can import x402-rails freely, because a test is not a cold start.
 */
const PROFILE_NETWORKS: Readonly<Record<McpProfileName, readonly string[]>> = {
  testnet: ['base-sepolia', 'eip155:84532'],
  mainnet: ['base', 'eip155:8453'],
};

export const DEFAULT_NETWORK_PROFILE: McpProfileName = 'testnet';

/** The networks a profile permits — what the guard and payer are bounded by. */
export function networksFor(profile: McpProfileName): readonly string[] {
  return PROFILE_NETWORKS[profile];
}

export const DEFAULT_MAX_BODY_BYTES = 64 * 1024;

/** A config with the defaults resolved, as the tools actually see it. */
export interface ResolvedMcpConfig extends ReinMcpConfig {
  escalationWaitMs: number;
  maxBodyBytes: number;
  networkProfile: McpProfileName;
}

export function resolveConfig(config: ReinMcpConfig): ResolvedMcpConfig {
  if (!config.engineUrl) throw new ConfigError('REIN_ENGINE_URL is required');
  if (!config.agentId) throw new ConfigError('REIN_AGENT_ID is required');
  return {
    ...config,
    escalationWaitMs: config.escalationWaitMs ?? 0,
    maxBodyBytes: config.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    networkProfile: config.networkProfile ?? DEFAULT_NETWORK_PROFILE,
  };
}

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

/**
 * Build a config from the environment, the way a harness's MCP config block
 * supplies it (`"env": { "REIN_ENGINE_URL": "..." }`).
 *
 * The payer is resolved by a DYNAMIC import so the real-rails dependency (and
 * viem behind it) is only loaded when a key was actually supplied: an advisory
 * install pays neither the startup cost nor the attack surface of a signing
 * stack it will never use.
 */
export async function configFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<ReinMcpConfig> {
  const engineUrl = env['REIN_ENGINE_URL'] ?? '';
  const agentId = env['REIN_AGENT_ID'] ?? '';
  if (!engineUrl) throw new ConfigError('REIN_ENGINE_URL is required');
  if (!agentId) throw new ConfigError('REIN_AGENT_ID is required');
  // Every misconfiguration has to surface as a ConfigError, because the only
  // thing a harness shows when a stdio server dies at boot is its stderr. A raw
  // schema stack there reads as "the server is broken" rather than "you typed
  // the agent id wrong", which is the difference between a fixed install and an
  // abandoned one.
  if (!URL.canParse(engineUrl)) {
    throw new ConfigError(`REIN_ENGINE_URL is not a URL: ${JSON.stringify(engineUrl)}`);
  }
  if (!AgentId.safeParse(agentId).success) {
    throw new ConfigError(
      `REIN_AGENT_ID is not a Rein agent id (expected "agt_" + ULID): ${JSON.stringify(agentId)}`,
    );
  }

  const networkProfile = profileFromEnv(env);

  const privateKey = env['REIN_PAYER_PRIVATE_KEY'];
  let payer: Payer | undefined;
  if (privateKey !== undefined && privateKey !== '') {
    if (!/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
      throw new ConfigError('REIN_PAYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key');
    }
    const { createX402Payer, PROFILES } = await import('@reinconsole/x402-rails');
    payer = createX402Payer({
      privateKey: privateKey as `0x${string}`,
      // Bounded on BOTH sides on purpose. The guard refuses a foreign network
      // before the engine is asked; this refuses one before a signature
      // exists, which is the boundary that still holds if someone builds a
      // payer without a guard in front of it.
      networks: networksFor(networkProfile),
      profile: PROFILES[networkProfile],
    });
  }

  return {
    engineUrl,
    agentId,
    ...(env['REIN_ENGINE_API_KEY'] ? { apiKey: env['REIN_ENGINE_API_KEY'] } : {}),
    ...(payer ? { payer } : {}),
    ...(env['REIN_MCP_TASK_ID'] ? { taskId: env['REIN_MCP_TASK_ID'] } : {}),
    escalationWaitMs: intFromEnv(env, 'REIN_MCP_ESCALATION_WAIT_MS', 0),
    maxBodyBytes: intFromEnv(env, 'REIN_MCP_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
    networkProfile,
  };
}

/**
 * `REIN_NETWORK_PROFILE`, defaulting to testnet.
 *
 * An unknown value is a ConfigError rather than a fallback to testnet: an
 * operator who typed `mainet` meant mainnet, and silently running their
 * production vendor against play money would look exactly like success.
 */
function profileFromEnv(env: NodeJS.ProcessEnv): McpProfileName {
  const raw = env['REIN_NETWORK_PROFILE'];
  if (raw === undefined || raw === '') return DEFAULT_NETWORK_PROFILE;
  const key = raw.trim().toLowerCase();
  if (key === 'testnet' || key === 'mainnet') return key;
  throw new ConfigError(
    `REIN_NETWORK_PROFILE must be "testnet" or "mainnet", got ${JSON.stringify(raw)}`,
  );
}

function intFromEnv(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new ConfigError(`${name} must be a non-negative number, got ${JSON.stringify(raw)}`);
  }
  return Math.floor(value);
}
