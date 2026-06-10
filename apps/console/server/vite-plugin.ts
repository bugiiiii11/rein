/**
 * Vite dev plugin: boots one live Rein world and mounts the console API as
 * middleware on the dev server, so `vite` is the only process you run in dev —
 * UI + API + SSE all on http://localhost:5173.
 */
import type { Plugin } from 'vite';
import { createWorld } from './world';
import { createApiHandler } from './api';

export function reinConsole(): Plugin {
  return {
    name: 'rein-console-api',
    apply: 'serve',
    async configureServer(server) {
      const world = await createWorld();
      const handle = createApiHandler(world);
      server.middlewares.use((req, res, next) => {
        if (!handle(req, res)) next();
      });
      server.httpServer?.once('close', () => {
        void world.close();
      });
    },
  };
}
