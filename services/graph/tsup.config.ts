import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  splitting: false,
  // @rein/core is bundled so the graph is a self-contained import.
  // fastify stays external (regular dependency).
  noExternal: ['@rein/core'],
});
