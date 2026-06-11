import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  splitting: false,
  // Unlike the other services, NOTHING is bundled here: @rein/policy-engine
  // must resolve to the same module instance the composing app uses (the
  // DecisionLog handed to the engine is nominally typed), and PGlite loads
  // WASM assets relative to its own package directory.
});
