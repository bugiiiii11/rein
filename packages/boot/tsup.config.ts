import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  // ESM only. Both consumers are ESM entry points -- the console's boot.ts under
  // tsx and services/store's bin shim -- and a CJS twin would be a second copy
  // of a module whose whole job is to run exactly once, first.
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node22',
});
