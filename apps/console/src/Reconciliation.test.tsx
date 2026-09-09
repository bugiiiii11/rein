/**
 * @vitest-environment happy-dom
 *
 * The reconciliation panel (B1). One branch here is load-bearing rather than
 * cosmetic: an engine nobody reports settlements to reads EVERY allowance as a
 * gap, and a panel that rendered that as an alarm would be raising one about
 * its own wiring. What is pinned here is that the three postures — no reporter,
 * all accounted for, real gaps — stay visibly different.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FeedItem, ReconciliationView } from '../server/wire';
import { Reconciliation } from './components/Reconciliation';

const view = (over: Partial<ReconciliationView> = {}): ReconciliationView => ({
  window: '24h',
  graceMs: 60_000,
  allowed: 0,
  allowedValue: '0',
  settled: 0,
  settledValue: '0',
  inFlight: 0,
  inFlightValue: '0',
  unsettled: 0,
  unsettledValue: '0',
  unattributed: 0,
  settlementsSeen: 0,
  gaps: [],
  at: '2026-09-09T00:00:00.000Z',
  ...over,
});

const gap = (over: Partial<ReconciliationView['gaps'][number]> = {}) => ({
  intentId: 'int_1',
  decisionId: 'dec_1',
  agentId: 'agt_1',
  agentName: 'session-agent-1',
  host: 'api.data.test',
  resource: '/v1/query',
  amount: '0.01',
  allowedAt: '2026-09-09T00:00:00.000Z',
  ageMs: 240_000,
  state: 'unsettled' as const,
  ...over,
});

const shadowItem: FeedItem = {
  seq: 1,
  at: '2026-09-09T00:00:00.000Z',
  kind: 'shadow',
  agentId: 'agt_2',
  agentName: 'research-agent-1',
  amount: '2.50',
  chain: 'base',
  txHash: '0xf47b8712345678907860',
};

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(
  reconciliation: ReconciliationView | null,
  feed: FeedItem[] = [],
): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Reconciliation, { reconciliation, feed }));
  });
  return host;
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const r = root;
  root = null;
  await act(async () => {
    r?.unmount();
  });
  host?.remove();
  host = null;
});

describe('Reconciliation panel', () => {
  it('says nobody is reporting rather than raising an alarm it cannot support', async () => {
    // Eight allowances, zero settlement reports: the gaps are a fact about the
    // deployment's wiring, not about its payments.
    const el = await render(
      view({ allowed: 8, settlementsSeen: 0, unsettled: 8, gaps: [gap()] }),
    );
    expect(el.textContent).toContain('No settlement source has reported');
    expect(el.querySelector('.recon-row')).toBeNull();
    expect(el.querySelector('.panel.alarm')).toBeNull();
    expect(el.textContent).toContain('all accounted for');
  });

  it('renders both directions of the join, unsettled first', async () => {
    const el = await render(
      view({ allowed: 8, settled: 7, settlementsSeen: 7, unsettled: 1, unsettledValue: '0.01', gaps: [gap()] }),
      [shadowItem],
    );
    const rows = [...el.querySelectorAll('.recon-row')];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain('unsettled');
    expect(rows[0]?.textContent).toContain('session-agent-1');
    expect(rows[1]?.textContent).toContain('shadow');
    expect(rows[1]?.textContent).toContain('research-agent-1');
    expect(el.querySelector('.panel.alarm')).not.toBeNull();
    expect(el.textContent).toContain('2 to answer for');
  });

  it('never lists an in-flight allowance — a fresh payment is not a gap', async () => {
    const el = await render(
      view({
        allowed: 8,
        settled: 7,
        settlementsSeen: 7,
        inFlight: 1,
        gaps: [gap({ state: 'in-flight', ageMs: 1_000 })],
      }),
    );
    expect(el.querySelector('.recon-row')).toBeNull();
    expect(el.textContent).toContain('Every allowance is accounted for');
    expect(el.querySelector('.panel.alarm')).toBeNull();
    // Counted, though: the strip still says one payment is in the air.
    expect(el.querySelector('.recon-strip')?.textContent).toContain('1 in flight');
  });

  it('caps the list and says how much it is hiding', async () => {
    const gaps = Array.from({ length: 6 }, (_, i) =>
      gap({ intentId: `int_${i}`, ageMs: (i + 1) * 60_000 }),
    );
    const el = await render(view({ allowed: 6, settlementsSeen: 3, unsettled: 6, gaps }));
    expect(el.querySelectorAll('.recon-row')).toHaveLength(4);
    expect(el.querySelector('.recon-more')?.textContent).toBe('+2 more');
    // The count in the header is the real one, not the truncated list length.
    expect(el.textContent).toContain('6 to answer for');
  });

  it('renders before the first snapshot lands', async () => {
    const el = await render(null);
    expect(el.textContent).toContain('Reconciliation');
    expect(el.textContent).toContain('all accounted for');
  });
});
