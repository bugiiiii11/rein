import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries, not one barrel: `src/auth.ts` needs node:crypto and the main
  // barrel is imported by the console's browser bundle. Keeping them separate
  // is what makes `@reinconsole/core/auth` safe to add to a schemas package.
  entry: ['src/index.ts', 'src/auth.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  target: 'node22',
});
