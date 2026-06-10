import type { ConsoleState } from '../server/wire';

export async function fetchState(): Promise<ConsoleState> {
  const res = await fetch('/api/state');
  if (!res.ok) throw new Error(`GET /api/state → ${res.status}`);
  return (await res.json()) as ConsoleState;
}

const post = (path: string): Promise<Response> => fetch(path, { method: 'POST' });

export const api = {
  runDemo: () => post('/api/demo/run'),
  freeze: (id: string) => post(`/api/agents/${id}/freeze`),
  unfreeze: (id: string) => post(`/api/agents/${id}/unfreeze`),
  ping: (id: string) => post(`/api/agents/${id}/ping`),
};
