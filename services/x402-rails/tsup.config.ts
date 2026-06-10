import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  splitting: false,
  // Workspace deps are bundled so the rails are a self-contained import.
  // viem stays external (regular dependency).
  noExternal: ['@rein/core', '@rein/sdk'],
});
