/**
 * Boot-time container concerns, shared by every Rein service that owns a
 * Railway volume. Today that is the console (`apps/console/server/boot.ts`) and
 * the hosted engine (`services/store/bin/rein-engine.mjs`); both call
 * `dropPrivileges` before anything opens the database.
 *
 * `checkServiceIdentity` answers a different question first -- am I even the
 * service this deployment is supposed to be running? One image serves all
 * three, so a missing start command silently starts the wrong one.
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

export {
  checkServiceIdentity,
  ServiceIdentityError,
  type ServiceIdentityOptions,
} from './identity.js';
