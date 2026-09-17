/**
 * Boot-time container concerns, shared by every Rein service that owns a
 * Railway volume. Today that is the console (`apps/console/server/boot.ts`) and
 * the hosted engine (`services/store/bin/rein-engine.mjs`); both call
 * `dropPrivileges` before anything opens the database.
 */
export {
  chownTree,
  dropPrivileges,
  parsePasswd,
  type ChownDeps,
  type DropOptions,
  type DropOutcome,
  type PosixUser,
} from './privileges.js';
