import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Every PGlite open boots a WASM Postgres (~2s on this class of machine),
    // and the restart tests open the same data dir two or three times.
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
