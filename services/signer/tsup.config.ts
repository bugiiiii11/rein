import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  splitting: false,
  // Workspace deps are bundled so the signer is a self-contained import.
  // viem and fastify stay external (regular dependencies).
  noExternal: ['@rein/core', '@rein/sdk', '@rein/x402-rails'],
});
