#!/usr/bin/env node
// Committed bin shim: it exists at install time, so pnpm can link this bin on a
// fresh clone before `pnpm build` creates dist/ (without it, a first install
// prints a wall of "Failed to create bin" warnings). dist/graph-server.js only
// boots when it believes it is the main module, so re-point argv[1] first.
//
// Deliberately NOT doing what rein-engine.mjs does. That bin chowns its volume
// and drops root before importing, because it is deployed to Railway where a
// volume is a root-owned bind mount. The graph service is not deployed
// anywhere, so the drop here would be code no environment exercises -- copy the
// five lines from rein-engine.mjs (and validate them in the image) if and when
// this service gets a volume of its own.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = new URL('../dist/graph-server.js', import.meta.url);
const entry = fileURLToPath(url); // argv[1] needs a path; import() needs a URL on Windows
if (!existsSync(entry)) {
  console.error('[rein] dist/graph-server.js not found — run `pnpm build` first.');
  process.exit(1);
}
process.argv[1] = entry;
await import(url.href);
