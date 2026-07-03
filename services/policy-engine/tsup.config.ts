import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  // Keep each entry self-contained: no shared chunks, so `import.meta.url` in
  // server.ts resolves to server.js (needed for run-as-main detection).
  splitting: false,
  // @reinconsole/core is bundled into the service output for a self-contained deploy.
  noExternal: ['@reinconsole/core'],
});
