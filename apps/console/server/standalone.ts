/**
 * Standalone production server: serves the built UI from `dist/` and mounts the
 * same console API. Run after `vite build`:  `tsx server/standalone.ts`
 * (or `pnpm --filter @reinconsole/console start`).
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWorld } from './world';
import { createApiHandler, resolveConsolePosture } from './api';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
};

// Set REIN_CONSOLE_DATA_DIR to run the console on @reinconsole/store: engine state
// and reputation evidence survive restarts (the boot seed runs once per dir).
const world = await createWorld({ dataDir: process.env.REIN_CONSOLE_DATA_DIR });

// A1: the console's mutating routes (freeze, unfreeze, ping, demo) are state
// changes on a live policy engine. Unconfigured public deployments serve the
// dashboard read-only rather than offering those to anyone who finds the URL.
const posture = resolveConsolePosture(process.env);
if (posture.warning) console.warn(`[rein] WARNING: ${posture.warning}`);
const handle = createApiHandler(world, posture);

async function serveFile(path: string): Promise<{ body: Buffer; type: string } | null> {
  try {
    const info = await stat(path);
    const file = info.isDirectory() ? join(path, 'index.html') : path;
    return { body: await readFile(file), type: MIME[extname(file)] ?? 'application/octet-stream' };
  } catch {
    return null;
  }
}

const server = createServer(async (req, res) => {
  if (handle(req, res)) return;

  const url = new URL(req.url ?? '/', 'http://localhost');
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const target = normalize(join(DIST, rel));
  if (!target.startsWith(DIST)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }

  const hit = (await serveFile(target)) ?? (await serveFile(join(DIST, 'index.html')));
  if (!hit) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('UI not built — run `pnpm --filter @reinconsole/console build` first.');
    return;
  }
  res.writeHead(200, { 'Content-Type': hit.type });
  res.end(hit.body);
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, posture.host, () =>
  // The pid is diagnostic, not decorative: the drain below only ever runs if the
  // signal actually reaches THIS process. Started via `pnpm ... start`, node is a
  // child, pnpm does not forward SIGTERM, and the drain is dead code — which is
  // exactly what happened in production until S37.
  //
  // Do NOT read this as "must be pid 1". tsx re-spawns the app in a child of its
  // own, so a correct container still reports something like pid 17. The question
  // is never who is pid 1, it is whether anything in the chain swallows SIGTERM.
  // The honest check is the pair of drain lines in the shutdown handler below.
  console.log(
    `[rein] console on http://${posture.host}:${port} (pid ${process.pid}, ` +
      `${posture.readOnly ? 'read-only' : 'writable'}, auth: ${posture.apiKey ? 'bearer' : 'none'})`,
  ),
);

/**
 * Graceful shutdown. Container runtimes (Railway included) stop a deploy with
 * SIGTERM, and `world.close()` is the only thing that drains the write-behind
 * tail. Persist-then-cache state — signer sessions, spend, revocations, gate
 * replay slots — is already acknowledged on disk and safe either way; what
 * dies with an un-drained process is up to 30s of gate receipts and reputation
 * evidence, everything since the last maintenance flush. Ephemerally that is
 * invisible. On a volume it is permanent, silent data loss on every redeploy.
 *
 * Order matters: `server.close()` alone would HANG here, because it waits for
 * open connections to end and the console's SSE streams never do. Stop
 * accepting, cut the streams, and only then drain the store.
 */
let closing = false;
const shutdown = async (signal: string): Promise<void> => {
  if (closing) return; // a second signal must not race the first drain
  closing = true;
  console.log(`[rein] ${signal} received — draining the store`);

  // Backstop: never let a wedged store hold the container open past the
  // runtime's kill deadline, which would turn a flush into a SIGKILL anyway.
  const abandon = setTimeout(() => {
    console.error('[rein] drain timed out after 10s — exiting with data possibly unflushed');
    process.exit(1);
  }, 10_000);
  abandon.unref();

  try {
    server.close();
    server.closeAllConnections();
    await world.close();
    clearTimeout(abandon);
    console.log('[rein] store drained, exiting cleanly');
    // Deliberately NOT process.exit() here. stdout to a container's log pipe is
    // async, and exiting immediately truncates the line above — the only
    // evidence the drain ran at all. The server and store are closed, so let
    // the loop end on its own; the unref'd timer is a backstop for a stray
    // handle and never keeps the process alive by itself.
    process.exitCode = 0;
    setTimeout(() => process.exit(0), 2000).unref();
  } catch (err) {
    console.error('[rein] drain failed (unflushed telemetry may be lost):', err);
    process.exitCode = 1;
    setTimeout(() => process.exit(1), 2000).unref();
  }
};

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
