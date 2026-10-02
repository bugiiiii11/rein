import type { FeedItem } from '../server/wire';

/**
 * What this console can honestly say about the audit chain from the rows it
 * is shown.
 *
 * The engine keeps ONE chain per deployment, and an org-scoped key sees only
 * its own org's rows of it (S56 tenancy). Since the sandbox went live (S86),
 * other tenants' decisions sit between ours on that chain, so "the previous
 * row I can see" is routinely NOT "the previous row on the chain" -- and a
 * check that reads every such gap as a break called a healthy chain broken on
 * the public console. Three verdicts, each from evidence the feed carries:
 *
 *   intact  -- every visible link's `prevHash` is the hash of the visible row
 *              before it: the window is one unbroken run of the chain.
 *   partial -- some links point at a hash this console cannot see: rows in
 *              another tenant's view, or before the window. Not a verdict on
 *              those rows; only the engine, or an unscoped operator, can
 *              verify the whole chain.
 *   broken  -- a link points at a VISIBLE hash that is not its predecessor:
 *              the rows between them are not on the chain that link is on.
 *              With one chain per engine that is a fork, never a scoping gap.
 */
export type ChainVerdict = 'empty' | 'intact' | 'partial' | 'broken';

export interface ChainStatus {
  verdict: ChainVerdict;
  /** Visible decisions carrying a hash. */
  visible: number;
  /** Links whose predecessor is the visible row before them. */
  verified: number;
  /** Links whose predecessor this console cannot see. */
  unseen: number;
  /** Hashes of the rows whose `prevHash` is unseen, for marking them in a list. */
  gaps: ReadonlySet<string>;
}

export function chainStatus(feed: FeedItem[]): ChainStatus {
  const rows = feed.filter((f) => f.kind === 'decision' && f.hash);
  const index = new Map<string, number>();
  rows.forEach((r, i) => index.set(r.hash as string, i));

  let verified = 0;
  let unseen = 0;
  let broken = false;
  const gaps = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const cur = rows[i];
    const prev = rows[i - 1];
    if (!cur || !prev) continue;
    if (cur.prevHash === prev.hash) {
      verified += 1;
    } else if (cur.prevHash && index.has(cur.prevHash)) {
      broken = true;
    } else {
      unseen += 1;
      gaps.add(cur.hash as string);
    }
  }

  const verdict: ChainVerdict =
    rows.length === 0 ? 'empty' : broken ? 'broken' : unseen > 0 ? 'partial' : 'intact';
  return { verdict, visible: rows.length, verified, unseen, gaps };
}
