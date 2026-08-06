#!/usr/bin/env node
// Committed bin shim: it exists at install time, so pnpm can link this bin on a
// fresh clone before `pnpm build` creates dist/ (without it, a first install
// prints a wall of "Failed to create bin" warnings). dist/server.js only boots
// when it believes it is the main module, so re-point argv[1] before importing.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = new URL('../dist/server.js', import.meta.url);
const entry = fileURLToPath(url); // argv[1] needs a path; import() needs a URL on Windows
if (!existsSync(entry)) {
  console.error('[rein] dist/server.js not found — run `pnpm build` first.');
  process.exit(1);
}
process.argv[1] = entry;
await import(url.href);
