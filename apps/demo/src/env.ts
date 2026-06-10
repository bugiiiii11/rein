import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Minimal .env handling for the demos: the file lives at the repo root
 * (gitignored), keys already in process.env win, and the wallet bootstrap
 * appends to it. No dotenv dependency.
 */

export function repoRoot(start = process.cwd()): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

export function envFilePath(): string {
  return join(repoRoot(), '.env');
}

export function readEnv(name: string): string | undefined {
  const fromProcess = process.env[name];
  if (fromProcess !== undefined && fromProcess !== '') return fromProcess;
  const path = envFilePath();
  if (!existsSync(path)) return undefined;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
    if (match && match[1] === name && match[2] !== '') return match[2];
  }
  return undefined;
}

export function appendEnv(entries: Record<string, string>): string {
  const path = envFilePath();
  const lines = Object.entries(entries)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const needsNewline = existsSync(path) && !readFileSync(path, 'utf8').endsWith('\n');
  appendFileSync(path, `${needsNewline ? '\n' : ''}${lines}\n`);
  return path;
}
