#!/usr/bin/env node
// Committed bin shim, like rein-mcp: it exists at install time, before dist/.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = new URL('../dist/cli.js', import.meta.url);
if (!existsSync(fileURLToPath(url))) {
  console.error('[rein] dist/cli.js not found — run `pnpm build` first.');
  process.exit(1);
}
const { main } = await import(url.href);
process.exitCode = await main(process.argv.slice(2));
