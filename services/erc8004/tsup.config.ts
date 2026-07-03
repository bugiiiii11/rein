import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  splitting: false,
  // @reinconsole/core is bundled so the package is a self-contained import.
  // viem stays external (regular dependency).
  noExternal: ['@reinconsole/core'],
});
