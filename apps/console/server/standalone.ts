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
import { createApiHandler } from './api';

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
const handle = createApiHandler(world);

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
server.listen(port, () => console.log(`[rein] console on http://localhost:${port}`));
