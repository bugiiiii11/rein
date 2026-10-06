import { newId } from '@reinconsole/core';
import type { MaybePromise } from './stores.js';

/**
 * Wallet sanctions screening (S98, a legal decision -- docs/legal/decisions.md
 * 2026-10-05): the hosted engine screens an org's wallets when it is CLAIMED
 * and again when it is moved to MAINNET, refuses either on a hit, and keeps a
 * record of every check.
 *
 * The source is Chainalysis's sanctions oracle, a contract on Ethereum mainnet
 * whose `isSanctioned(address)` reads Chainalysis's own published list. It was
 * chosen over Chainalysis's REST API (S98) because it needs no account or key,
 * anyone can re-run the exact check we ran, and nobody but an RPC provider
 * sees the address -- while the REST API answers a keyless request with a
 * Cloudflare block page. Several public RPCs are tried in turn; an answer
 * from any of them settles it.
 *
 * Fail closed: when no RPC answers, the claim or the mainnet move is refused
 * with `503 screening_unavailable` and can be retried. A hit is refused with a
 * deliberately plain `403 screening_refused` that names no list, and logged.
 *
 * Which addresses: the owner's, when they signed in with Ethereum
 * (`eth:<address>`; a GitHub sign-in has no wallet), and every wallet the org's
 * agents registered -- the sandbox records the one `init` generated. Honest
 * limit, the same one the mainnet gate states: the engine cannot see which
 * wallet actually signs a payment, so a wallet added after the check, or one
 * swapped into `rein-agent.json` by hand, was never screened.
 */

/** Chainalysis sanctions oracle -- the same address on every chain it is deployed to. */
export const CHAINALYSIS_ORACLE = '0x40C57923924B5c5c5455c48D93317139ADDaC8fb';
/** `isSanctioned(address)` */
const IS_SANCTIONED = '0xdf592f7d';
export const DEFAULT_SCREENING_RPCS: readonly string[] = [
  'https://ethereum-rpc.publicnode.com',
  'https://eth.llamarpc.com',
  'https://eth.drpc.org',
];
/** Per RPC. Three of them must fit inside the console's 10 s wait on a claim. */
const RPC_TIMEOUT_MS = 2_500;

export type ScreeningTrigger = 'claim' | 'mainnet';
export type ScreeningResult = 'clear' | 'sanctioned' | 'unavailable';

/** One address, checked once. What the sanctions runbook's table records. */
export interface ScreeningRecord {
  id: string;
  /** ISO time of the check. */
  at: string;
  orgId: string;
  trigger: ScreeningTrigger;
  /** Lowercase 0x address. */
  address: string;
  role: 'owner' | 'agent';
  agentId?: string;
  result: ScreeningResult;
  /** e.g. `chainalysis-oracle@ethereum-rpc.publicnode.com` -- which list, read where. */
  source: string;
  /** Why it was unavailable. */
  detail?: string;
}

export interface ScreeningStorePort {
  record(rec: ScreeningRecord): MaybePromise<void>;
  /** Oldest first. */
  list(): readonly ScreeningRecord[];
}

export class InMemoryScreeningStore implements ScreeningStorePort {
  private readonly rows: ScreeningRecord[] = [];
  record(rec: ScreeningRecord): void {
    this.rows.push(rec);
  }
  list(): readonly ScreeningRecord[] {
    return this.rows;
  }
}

export interface ScreenVerdict {
  sanctioned: boolean;
  source: string;
}

/** Says whether one address is sanctioned, or throws when it cannot tell. */
export interface SanctionsScreener {
  screen(address: string): Promise<ScreenVerdict>;
  /** For the boot log. */
  readonly describe: string;
}

export class ScreeningError extends Error {
  constructor(
    readonly status: 403 | 503,
    readonly code: 'screening_refused' | 'screening_unavailable',
    message: string,
  ) {
    super(message);
    this.name = 'ScreeningError';
  }
}

/** The oracle over JSON-RPC `eth_call`, first RPC that answers wins. */
export function chainalysisOracle(
  options: { rpcUrls?: readonly string[]; fetch?: typeof fetch; timeoutMs?: number } = {},
): SanctionsScreener {
  const rpcUrls = options.rpcUrls?.length ? options.rpcUrls : DEFAULT_SCREENING_RPCS;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? RPC_TIMEOUT_MS;
  return {
    describe: `Chainalysis sanctions oracle on Ethereum via ${rpcUrls.map((u) => hostOf(u)).join(', ')}`,
    async screen(address) {
      const data = `${IS_SANCTIONED}${address.toLowerCase().replace(/^0x/, '').padStart(64, '0')}`;
      const failures: string[] = [];
      for (const url of rpcUrls) {
        try {
          const res = await doFetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              method: 'eth_call',
              params: [{ to: CHAINALYSIS_ORACLE, data }, 'latest'],
            }),
            signal: AbortSignal.timeout(timeoutMs),
          });
          const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { message?: unknown } };
          // A bool comes back as one 32-byte word; anything else is not an answer.
          if (!res.ok || typeof body.result !== 'string' || !/^0x[0-9a-f]{64}$/i.test(body.result)) {
            failures.push(`${hostOf(url)}: ${res.status} ${String(body.error?.message ?? 'no result')}`);
            continue;
          }
          return { sanctioned: BigInt(body.result) !== 0n, source: `chainalysis-oracle@${hostOf(url)}` };
        } catch (err) {
          failures.push(`${hostOf(url)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      throw new Error(`no RPC answered: ${failures.join('; ')}`);
    },
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** One address to check and whose it is. */
export interface ScreeningSubject {
  address: string;
  role: 'owner' | 'agent';
  agentId?: string;
}

/** The owner identity's wallet, if it has one (`eth:<address>`). */
export function ownerWallet(identity: string | undefined): string | undefined {
  return identity?.startsWith('eth:') ? identity.slice(4) : undefined;
}

/**
 * Screen every subject, record each answer, and throw on a hit (403) or on any
 * address nobody could answer for (503). Clean = returns. Subjects are checked
 * in parallel and deduplicated by address.
 */
export class ScreeningService {
  constructor(
    readonly screener: SanctionsScreener,
    readonly store: ScreeningStorePort = new InMemoryScreeningStore(),
    private readonly now: () => number = Date.now,
  ) {}

  async check(orgId: string, trigger: ScreeningTrigger, subjects: readonly ScreeningSubject[]): Promise<ScreeningRecord[]> {
    const seen = new Set<string>();
    const unique = subjects.filter((s) => {
      const a = s.address.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(a) || seen.has(a)) return false;
      seen.add(a);
      return true;
    });
    const records = await Promise.all(
      unique.map(async (s): Promise<ScreeningRecord> => {
        const base = {
          id: newId('scr'),
          at: new Date(this.now()).toISOString(),
          orgId,
          trigger,
          address: s.address.toLowerCase(),
          role: s.role,
          ...(s.agentId ? { agentId: s.agentId } : {}),
        };
        try {
          const verdict = await this.screener.screen(base.address);
          return { ...base, result: verdict.sanctioned ? 'sanctioned' : 'clear', source: verdict.source };
        } catch (err) {
          return {
            ...base,
            result: 'unavailable',
            source: 'none',
            detail: (err instanceof Error ? err.message : String(err)).slice(0, 500),
          };
        }
      }),
    );
    for (const rec of records) await this.store.record(rec);
    const hits = records.filter((r) => r.result === 'sanctioned');
    if (hits.length > 0) {
      // The operator's cue to follow the sanctions runbook; the caller is told nothing specific.
      console.warn(
        `[rein] SANCTIONS HIT at ${trigger} for org ${orgId}: ${hits.map((h) => `${h.role} ${h.address}`).join(', ')} ` +
          `(GET /v1/screenings?orgId=${orgId})`,
      );
      throw new ScreeningError(
        403,
        'screening_refused',
        `this request cannot be completed for org ${orgId}; write to reinconsole@proton.me if you think this is a mistake`,
      );
    }
    if (records.some((r) => r.result === 'unavailable')) {
      throw new ScreeningError(
        503,
        'screening_unavailable',
        'the sanctions check could not be completed right now; try again in a few minutes',
      );
    }
    return records;
  }

  /** Newest first, optionally one org's. */
  list(options: { orgId?: string; limit?: number } = {}): ScreeningRecord[] {
    const all = this.store.list().filter((r) => options.orgId === undefined || r.orgId === options.orgId);
    return all.slice(-(options.limit ?? 200)).reverse();
  }
}

/**
 * `REIN_SANCTIONS_SCREENING`: `off`, or `on`/unset. Unset = `fallback` decides
 * (the hosted bin passes true where the sandbox is on). `REIN_SANCTIONS_RPC_URLS`
 * replaces the default RPC list (comma-separated, tried in order).
 */
export function screenerFromEnv(env: NodeJS.ProcessEnv, fallback: boolean): SanctionsScreener | undefined {
  const raw = env['REIN_SANCTIONS_SCREENING']?.trim().toLowerCase();
  if (raw === 'off' || raw === '0' || raw === 'false' || raw === 'no') return undefined;
  if (raw && raw !== 'on' && raw !== '1' && raw !== 'true' && raw !== 'yes') {
    throw new Error(`REIN_SANCTIONS_SCREENING=${raw} is not on or off`);
  }
  if (!raw && !fallback) return undefined;
  const urls = (env['REIN_SANCTIONS_RPC_URLS'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const url of urls) {
    if (!/^https:\/\//.test(url)) throw new Error(`REIN_SANCTIONS_RPC_URLS: ${url} is not an https URL`);
  }
  return chainalysisOracle(urls.length ? { rpcUrls: urls } : {});
}
