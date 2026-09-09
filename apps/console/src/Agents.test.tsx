/**
 * @vitest-environment happy-dom
 *
 * The dead-man chip on the agent card (B2). Three distinctions are load-bearing
 * rather than cosmetic, and each is one the UI could quietly get wrong:
 *
 *   - an UNWATCHED agent shows no chip at all. Absence means "nobody declared a
 *     cadence", not "healthy" — a green chip on every episodic agent would be a
 *     claim the console has no basis for;
 *   - `unknown` is not an alarm. The console restarted more recently than the
 *     silence it can see, and rendering that in alarm red would page someone
 *     about a deploy;
 *   - the header counts only real alarms, for the same reason.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentLivenessView, AgentView } from '../server/wire';
import { Agents } from './components/Agents';

const agent = (over: Partial<AgentView> = {}): AgentView => ({
  id: 'agt_1',
  name: 'research-agent-1',
  labels: ['research'],
  status: 'active',
  mode: 'sdk',
  chain: 'base',
  address: '0xresearchWallet',
  spent: '0.04',
  calls: 4,
  createdAt: '2026-09-09T00:00:00.000Z',
  ...over,
});

const liveness = (over: Partial<AgentLivenessView> = {}): AgentLivenessView => ({
  interval: '5m',
  status: 'alive',
  silentMs: 30_000,
  lastSeenAt: '2026-09-09T00:00:00.000Z',
  lastSource: 'intent',
  note: 'polls the vendor feed on a schedule',
  ...over,
});

let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function render(agents: AgentView[]): Promise<HTMLDivElement> {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root?.render(createElement(Agents, { agents, writable: false }));
  });
  return host;
}

const chip = (el: HTMLDivElement) => el.querySelector('.tag.liveness');

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  const r = root;
  await act(async () => r?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('the dead-man chip', () => {
  it('renders nothing for an agent nobody watches', async () => {
    const el = await render([agent()]);
    expect(chip(el)).toBeNull();
    expect(el.textContent).toContain('1 managed');
    expect(el.textContent).not.toContain('silent');
  });

  it('shows the cadence while the agent is alive', async () => {
    const el = await render([agent({ liveness: liveness() })]);
    expect(chip(el)?.className).toContain('alive');
    expect(chip(el)?.textContent).toBe('live · every 5m');
  });

  it('shows how long a missing agent has been silent, and counts it', async () => {
    const el = await render([
      agent({ liveness: liveness({ status: 'missing', silentMs: 11_400_000 }) }),
    ]);
    expect(chip(el)?.className).toContain('missing');
    expect(chip(el)?.textContent).toBe('silent 3h 10m');
    expect(el.textContent).toContain('1 silent');
    // The operator's note is the only human context an alarm carries.
    expect(chip(el)?.getAttribute('title')).toContain('polls the vendor feed');
  });

  it('marks an unwitnessed silence as unknown, and does not count it', async () => {
    const el = await render([
      agent({ liveness: liveness({ status: 'unknown', silentMs: 3 * 86_400_000 }) }),
    ]);
    expect(chip(el)?.className).toContain('unknown');
    expect(chip(el)?.textContent).toContain('unwitnessed');
    expect(chip(el)?.getAttribute('title')).toContain('restarted');
    // Not an alarm: a restart must not make the header cry.
    expect(el.textContent).not.toContain('1 silent');
  });

  it('does not count a LATE agent either — it is inside its grace', async () => {
    const el = await render([agent({ liveness: liveness({ status: 'late', silentMs: 330_000 }) })]);
    expect(chip(el)?.className).toContain('late');
    expect(el.textContent).toContain('1 managed');
    expect(el.textContent).not.toContain('silent 5m ·');
  });

  it('counts only the missing among a mixed roster', async () => {
    const el = await render([
      agent({ id: 'agt_1', name: 'a', liveness: liveness() }),
      agent({ id: 'agt_2', name: 'b', liveness: liveness({ status: 'missing' }) }),
      agent({ id: 'agt_3', name: 'c' }),
      agent({ id: 'agt_4', name: 'd', liveness: liveness({ status: 'missing' }) }),
    ]);
    expect(el.textContent).toContain('4 managed · 2 silent');
    expect(el.querySelectorAll('.tag.liveness')).toHaveLength(3);
  });
});
