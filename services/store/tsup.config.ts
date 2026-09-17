import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/server.ts', 'src/graph-server.ts', 'src/privileges.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  target: 'node22',
  splitting: false,
  // Unlike the other services, almost NOTHING is bundled here:
  // @reinconsole/policy-engine must resolve to the same module instance the
  // composing app uses (the DecisionLog handed to the engine is nominally
  // typed), and PGlite loads WASM assets relative to its own package directory.
  //
  // @reinconsole/boot is the one exception, and neither reason touches it: it
  // has no module identity to share (pure functions over node: builtins) and no
  // assets to locate. It is bundled because it is PRIVATE while bin/ is
  // published -- see src/privileges.ts. Keep this list at one entry unless the
  // same two tests apply.
  noExternal: ['@reinconsole/boot'],
});
