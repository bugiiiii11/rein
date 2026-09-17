/**
 * The engine's access to the shared privilege drop -- a re-export, and a
 * deliberate one.
 *
 * `@reinconsole/boot` is private and never packed, but this package DOES publish
 * `bin/`, and `bin/rein-engine.mjs` drops privileges before it boots the server.
 * If that bin imported the package by name, every npm consumer would hit an
 * unresolvable specifier the moment they ran `rein-engine`. So the bin imports
 * `../dist/privileges.js` by relative path instead, and `tsup.config.ts` names
 * `@reinconsole/boot` in `noExternal` so this entry lands self-contained in the
 * tarball.
 *
 * NOT in package.json's `exports` map, on purpose: the file ships, but there is
 * no specifier a consumer can reach it by. Adding one would make chownTree and
 * dropPrivileges public API, which is the decision this indirection avoids.
 */
export {
  chownTree,
  dropPrivileges,
  parsePasswd,
  type ChownDeps,
  type DropOptions,
  type DropOutcome,
  type PosixUser,
} from '@reinconsole/boot';
