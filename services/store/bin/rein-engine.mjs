#!/usr/bin/env node
// Committed bin shim: it exists at install time, so pnpm can link this bin on a
// fresh clone before `pnpm build` creates dist/ (without it, a first install
// prints a wall of "Failed to create bin" warnings). dist/server.js only boots
// when it believes it is the main module, so re-point argv[1] before importing.
//
// It is also the engine's privilege drop, for the same reason the console has a
// boot.ts (S61): a Railway volume is a bind mount that lands ROOT-owned even
// when it is brand new, so the container starts as root (RAILWAY_RUN_UID=0),
// chowns /data/engine, and becomes `node` here -- inside the container that
// will serve, at the one moment no other writer exists. Chowning from a shell
// cannot win that race; two attempts cost an outage. See privileges.js.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const url = new URL('../dist/server.js', import.meta.url);
const entry = fileURLToPath(url); // argv[1] needs a path; import() needs a URL on Windows
// Imported by RELATIVE PATH, not as '@reinconsole/boot': that package is private
// and this bin is published, so a bare specifier would be unresolvable for an
// npm consumer. src/privileges.ts re-exports it and tsup bundles it in.
const privileges = new URL('../dist/privileges.js', import.meta.url);
// Both are checked, so a dist built before the drop existed says `pnpm build`
// rather than throwing ERR_MODULE_NOT_FOUND out of an import three lines down.
for (const missing of [entry, fileURLToPath(privileges)].filter((p) => !existsSync(p))) {
  console.error(`[rein] ${missing} not found — run \`pnpm build\` first.`);
  process.exit(1);
}

const { dropPrivileges } = await import(privileges.href);
// Fails soft: any problem here leaves the process running as root, which is the
// pre-drop production state, rather than crash-looping a public service.
// REIN_DATA_DIR matches what dist/server.js will open a moment from now --
// out of sync, the drop chowns the wrong tree and PGlite opens root-owned.
dropPrivileges({ dataDir: process.env.REIN_DATA_DIR ?? '.rein-data', log: (m) => console.warn(m) });

// Must stay AFTER the drop and stay DYNAMIC. A static import would hoist above
// it and let PGlite open the data dir as root -- silently, since it still works
// -- and setuid is a door that locks behind you: an already-open root-owned
// handle is the one thing the drop cannot repair.
process.argv[1] = entry;
await import(url.href);
