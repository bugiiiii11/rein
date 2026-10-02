/**
 * The audit-chain verdict (src/chain.ts). The one that matters is the third:
 * on the public console an org-scoped key sees a SUBSEQUENCE of the engine's
 * single chain, and the old check read every tenant gap as "Chain broken".
 */
import { describe, expect, it } from 'vitest';
import type { FeedItem } from '../server/wire';
import { chainStatus } from './chain';

const at = '2026-10-02T00:00:00.000Z';
const dec = (seq: number, hash: string, prevHash: string): FeedItem => ({
  seq,
  at,
  kind: 'decision',
  outcome: 'allow',
  hash,
  prevHash,
});

describe('chainStatus', () => {
  it('has nothing to say without a hashed decision', () => {
    expect(chainStatus([{ seq: 1, at, kind: 'settled' }]).verdict).toBe('empty');
  });

  it('is intact when every visible link names the visible row before it', () => {
    const s = chainStatus([dec(1, 'a', '0'), dec(2, 'b', 'a'), dec(3, 'c', 'b')]);
    expect(s).toMatchObject({ verdict: 'intact', visible: 3, verified: 2, unseen: 0 });
  });

  it('reads a link to a hash it cannot see as a partial view, not a break', () => {
    // Another tenant's row sits between b and c on the one chain this engine keeps.
    const s = chainStatus([dec(1, 'a', '0'), dec(2, 'b', 'a'), dec(4, 'c', 'other-tenant')]);
    expect(s).toMatchObject({ verdict: 'partial', visible: 3, verified: 1, unseen: 1 });
    expect([...s.gaps]).toEqual(['c']);
  });

  it('is broken only when a link skips past rows it can see', () => {
    // c names a as its predecessor, so b is on no chain c is on: a fork.
    const s = chainStatus([dec(1, 'a', '0'), dec(2, 'b', 'a'), dec(3, 'c', 'a')]);
    expect(s.verdict).toBe('broken');
  });

  it('ignores non-decision rows and the edge of the window', () => {
    const s = chainStatus([
      dec(9, 'x', 'before-the-window'),
      { seq: 10, at, kind: 'settled' },
      dec(11, 'y', 'x'),
    ]);
    expect(s).toMatchObject({ verdict: 'intact', visible: 2, verified: 1, unseen: 0 });
  });
});
