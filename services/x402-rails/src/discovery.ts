import { z } from 'zod';
import type { FetchLike } from '@reinconsole/sdk';
import { FacilitatorHttpError } from './errors.js';
import { chainIdForNetwork } from './networks.js';
import type { NetworkProfile } from './profiles.js';

/**
 * PayAI's public x402 catalog: keyless, paginated, both dialects and every
 * chain PayAI serves (Solana, Base, Base Sepolia, others) in one list.
 *
 * Chosen over `listX402DiscoveryResources` from `@coinbase/cdp-sdk` (S74): it
 * is a plain GET, needs no SDK, and returns the same Bazaar-shaped entries.
 */
export const PAYAI_DISCOVERY_URL = 'https://facilitator.payai.network/discovery/resources';

/**
 * One payable offer of one catalog entry, reduced to what a buyer decides on.
 * `amount` is ATOMIC (USDC has 6 decimals), read from `amount` on a v2 entry
 * and `maxAmountRequired` on a v1 one.
 */
export interface DiscoveredResource {
  resource: string;
  x402Version: number;
  network: string;
  asset: string;
  amount: bigint;
  /** HTTP method the entry declares, upper-cased; undefined if it declares none. */
  method: string | undefined;
  description: string | undefined;
}

export interface DiscoveryCriteria {
  profile: NetworkProfile;
  /** Inclusive ceiling, atomic units of the profile's USDC. */
  maxAtomic: bigint;
  /** Only entries that DECLARE this method. Default 'GET'. */
  method?: string;
  /** Hosts to leave out -- e.g. our own vendor, so "third party" means it. */
  excludeHosts?: readonly string[];
}

// Third-party data: read only the fields a decision depends on, tolerate the
// rest, and drop an entry that cannot be read rather than failing the page.
const Offer = z
  .object({
    scheme: z.string().optional(),
    network: z.string(),
    asset: z.string(),
    amount: z.string().optional(),
    maxAmountRequired: z.string().optional(),
    outputSchema: z
      .object({ input: z.object({ method: z.string().optional() }).passthrough().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const Entry = z
  .object({
    resource: z.string(),
    x402Version: z.number().optional(),
    description: z.string().nullish(),
    accepts: z.array(z.unknown()).default([]),
    extensions: z
      .object({
        bazaar: z
          .object({
            info: z
              .object({ input: z.object({ method: z.string().optional() }).passthrough() })
              .passthrough()
              .optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const Page = z
  .object({
    items: z.array(z.unknown()),
    pagination: z.object({ total: z.number().optional() }).passthrough().optional(),
  })
  .passthrough();

/**
 * The offers in `items` a buyer on `criteria.profile` could pay, cheapest first.
 *
 * Kept deliberately narrow, because each thing it lets through is something an
 * unattended runner will try to buy:
 * - the offer must be on the profile's CHAIN (either dialect) and in the
 *   profile's USDC -- an asset match by address, never by a symbol the entry
 *   names itself (the S73 `extra.symbol` lesson);
 * - the scheme must be `exact`, the only one the payer implements;
 * - the entry must DECLARE the method: a POST endpoint answers a GET with a
 *   400 or a 405, which reads as a dead service rather than a mismatch;
 * - a route TEMPLATE (`/inboxes/:inbox_id`, `{id}`) is not a URL and is
 *   dropped rather than guessed at.
 */
export function selectDiscovered(
  items: readonly unknown[],
  criteria: DiscoveryCriteria,
): DiscoveredResource[] {
  const method = (criteria.method ?? 'GET').toUpperCase();
  const excluded = new Set((criteria.excludeHosts ?? []).map((h) => h.toLowerCase()));
  const usdc = criteria.profile.usdc.toLowerCase();
  const out: DiscoveredResource[] = [];

  for (const raw of items) {
    const entry = Entry.safeParse(raw);
    if (!entry.success) continue;
    const { resource } = entry.data;
    if (!isConcreteUrl(resource) || excluded.has(new URL(resource).host.toLowerCase())) continue;

    for (const rawOffer of entry.data.accepts) {
      const offer = Offer.safeParse(rawOffer);
      if (!offer.success) continue;
      const o = offer.data;
      if (o.scheme !== undefined && o.scheme !== 'exact') continue;
      if (chainIdForNetwork(o.network) !== criteria.profile.chainId) continue;
      if (o.asset.toLowerCase() !== usdc) continue;

      const atomic = o.amount ?? o.maxAmountRequired;
      if (atomic === undefined || !/^\d+$/.test(atomic)) continue;
      const amount = BigInt(atomic);
      // A $0 offer is free content wearing a paywall: nothing to govern.
      if (amount === 0n || amount > criteria.maxAtomic) continue;

      const declared =
        entry.data.extensions?.bazaar?.info?.input.method ?? o.outputSchema?.input?.method;
      if (declared?.toUpperCase() !== method) continue;

      out.push({
        resource,
        x402Version: entry.data.x402Version ?? 1,
        network: o.network,
        asset: o.asset,
        amount,
        method: declared.toUpperCase(),
        description: entry.data.description ?? undefined,
      });
      break; // one offer per entry is enough to buy it
    }
  }
  return out.sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
}

function isConcreteUrl(resource: string): boolean {
  let url: URL;
  try {
    url = new URL(resource);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return !/\/:[^/]+|[{}]|%7B|%7D/i.test(url.pathname);
}

export interface DiscoverOptions extends DiscoveryCriteria {
  url?: string;
  fetch?: FetchLike;
  pageSize?: number;
  /** Stop after this many pages even if nothing matched. Default 20. */
  maxPages?: number;
  /** Stop as soon as this many matches are in hand. Default 10. */
  want?: number;
}

/**
 * Walk the catalog page by page until `want` matches or `maxPages` pages.
 * Returns what it found, cheapest first -- possibly nothing, which is the
 * caller's to report: an empty catalog is not an error in the catalog.
 */
export async function discoverResources(options: DiscoverOptions): Promise<DiscoveredResource[]> {
  const f = options.fetch ?? globalThis.fetch;
  const base = options.url ?? PAYAI_DISCOVERY_URL;
  const pageSize = options.pageSize ?? 100;
  const maxPages = options.maxPages ?? 20;
  const want = options.want ?? 10;
  const found: DiscoveredResource[] = [];

  for (let page = 0; page < maxPages && found.length < want; page += 1) {
    const res = await f(`${base}?limit=${pageSize}&offset=${page * pageSize}`, {});
    if (!res.ok) throw new FacilitatorHttpError(res.status, await res.text());
    const body = Page.parse(await res.json());
    found.push(...selectDiscovered(body.items, options));
    const total = body.pagination?.total;
    if (body.items.length < pageSize || (total !== undefined && (page + 1) * pageSize >= total)) {
      break;
    }
  }
  return found.sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
}
