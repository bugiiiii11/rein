/**
 * @vitest-environment happy-dom
 *
 * The escalations panel (A2 rendered, B3). Two things here are load-bearing
 * rather than cosmetic, and both are about what the panel must NOT do:
 *
 *   - it offers no way to answer. An approval is a signature over
 *     decisionId+intentHash from a registered key; a button that stood in for
 *     one would be the click-to-approve path A2 exists to refuse, so the test
 *     asserts the absence of any control.
 *   - with no approver key registered, a parked payment is awaiting an expiry
 *     rather than a human, and the panel says so — the same honesty valve as
 *     B1's `settlementsSeen === 0`.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { EscalationView, EscalationsView } from '../server/wire';
import { Escalations } from './components/Escalations';

const parked = (over: Partial<EscalationView> = {}): EscalationView => ({
  decisionId: 'dec_parked',
  intentId: 'int_1',
  intentHash: 'hash_1',
  agentId: 'agt_1',
  agentName: 'probation-agent-1',
  host: 'api.data.test',
  resource: '/v1/query',
  amount: '0.01',
  reason: 'breaker probation tripped: 3 calls in 1h exceeds 2',
  breakers: ['probation'],
  status: 'pending',
  createdAt: '2026-09-14T00:00:00.000Z',
  expiresAt: '2026-09-15T00:00:00.000Z',
  expiresInMs: 3_600_000,
  challenge: {
    approve: 'rein:approval/v1|dec_parked|hash|approve',
    reject: 'rein:approval/v1|dec_parked|hash|reject',
  },
  ...over,
});

const view = (over: Partial<EscalationsView> = {}): EscalationsView => ({
  approvers: [],
  ttlMs: 86_400_000,
  pending: [],
  recent: [],
  at: '2026-09-14T00:00:00.000Z',
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(escalations: EscalationsView | null): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Escalations, { escalations }));
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

describe('Escalations panel', () => {
  it('offers no way to approve — not a button, not an input, not a link', async () => {
    const el = await render(view({ approvers: [{ id: 'apk_1', name: 'on-call' }], pending: [parked()] }));
    expect(el.querySelectorAll('button')).toHaveLength(0);
    expect(el.querySelectorAll('input')).toHaveLength(0);
    expect(el.querySelectorAll('a')).toHaveLength(0);
    // The bytes are shown so a human can sign them elsewhere.
    expect(el.innerHTML).toContain('rein:approval/v1|dec_parked|hash|approve');
    expect(el.innerHTML).toContain('rein:approval/v1|dec_parked|hash|reject');
  });

  it('says nobody can answer when no approver key is registered', async () => {
    const el = await render(view({ approvers: [], pending: [parked()] }));
    expect(el.textContent).toContain('No approver key is registered');
    expect(el.textContent).toContain('expire into denials');
    expect(el.querySelector('.panel')?.className).toContain('alarm');
  });

  it('drops that note once a key exists — then a human really is being asked', async () => {
    const el = await render(view({ approvers: [{ id: 'apk_1', name: 'on-call' }], pending: [parked()] }));
    expect(el.textContent).not.toContain('No approver key is registered');
    expect(el.textContent).toContain('1 awaiting a signature');
  });

  it('is calm and unalarmed when policy decided everything itself', async () => {
    const el = await render(view());
    expect(el.textContent).toContain('No payment has needed a human');
    expect(el.querySelector('.panel')?.className).not.toContain('alarm');
  });

  it('shows what became of a resolved one, without offering its bytes again', async () => {
    const el = await render(
      view({
        recent: [
          parked({
            decisionId: 'dec_done',
            status: 'expired',
            expiresInMs: -1000,
            challenge: undefined,
          }),
        ],
      }),
    );
    expect(el.textContent).toContain('expired');
    // "denied" is the honest word for an expiry: fail closed, on the chain.
    expect(el.textContent).toContain('denied');
    expect(el.innerHTML).not.toContain('rein:approval/v1');
    // A resolved request alone is history, not an alarm.
    expect(el.querySelector('.panel')?.className).not.toContain('alarm');
  });

  it('renders nothing alarming before the first snapshot arrives', async () => {
    const el = await render(null);
    expect(el.textContent).toContain('No payment has needed a human');
  });
});
