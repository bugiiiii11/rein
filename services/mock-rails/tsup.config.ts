import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  splitting: false,
  // Workspace deps are bundled so the mock rails are a self-contained import.
  noExternal: ['@rein/core', '@rein/sdk'],
});
