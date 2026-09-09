import type { ConsoleState, ControlPosture } from '../server/wire';

export async function fetchState(): Promise<ConsoleState> {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
  return (await res.json()) as ConsoleState;
}

/**
 * What this console will let us do. Fetched once at boot so the UI can render
 * honestly — a read-only deployment must not show controls that answer 403.
 *
 * Failure is read as READ-ONLY, deliberately: the one thing worse than hiding
 * a working button is offering a dead one, and a console that cannot even
 * report its posture is not one to send mutations at.
 */
export async function fetchControl(): Promise<ControlPosture> {
  try {
    const res = await fetch('/api/control');
    if (!res.ok) return { writable: false, auth: 'none' };
    return (await res.json()) as ControlPosture;
  } catch {
    return { writable: false, auth: 'none' };
  }
}

const post = (path: string): Promise<Response> => fetch(path, { method: 'POST' });

export const api = {
  runDemo: () => post('/api/demo/run'),
  freeze: (id: string) => post(`/api/agents/${id}/freeze`),
  unfreeze: (id: string) => post(`/api/agents/${id}/unfreeze`),
  ping: (id: string) => post(`/api/agents/${id}/ping`),
};
