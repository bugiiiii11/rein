/**
 * Vitest must NOT inherit vite.config.ts: the reinConsole() dev plugin boots a
 * live world (engine HTTP server and all) in configureServer, which vitest's
 * internal dev server would happily run — leaking a whole second world into
 * the test process and keeping it alive after the run. Tests build their own
 * worlds explicitly.
 *
 * The default environment is node, for the server tests. Client tests opt into
 * a DOM per-file with `@vitest-environment happy-dom` rather than switching
 * globally — the server suite boots real engines and PGlite, and has no reason
 * to pay for (or run against) a synthetic DOM.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { environment: 'node' },
});
