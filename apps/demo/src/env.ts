import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { profileFor, TESTNET, type NetworkProfile } from '@reinconsole/x402-rails';

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

/**
 * The network profile the demos run against, from `REIN_NETWORK_PROFILE`
 * (default testnet). This is the one place a demo learns which money it is
 * about to move, and every rail it builds takes the returned profile rather
 * than a Sepolia constant.
 *
 * Reading the env HERE rather than in @reinconsole/x402-rails is the rule the
 * rails package keeps: libraries stay env-free so two profiles can coexist in
 * one process; composing apps do the reading.
 */
export function profileFromEnv(): NetworkProfile {
  const raw = readEnv('REIN_NETWORK_PROFILE');
  return raw === undefined || raw === '' ? TESTNET : profileFor(raw);
}
