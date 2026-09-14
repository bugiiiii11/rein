import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  // Same reason as the policy engine: no shared chunks, so `import.meta.url` in
  // server.ts resolves to server.js and run-as-main detection works.
  splitting: false,
});
