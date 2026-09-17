/**
 * Production entry point. The deployed start command names THIS file, not
 * standalone.ts, and the two lines below are the whole reason it exists:
 * drop root before the world is built, then hand over.
 *
 * The import must stay dynamic. standalone.ts opens the database at module
 * scope, so a static import would be hoisted above the drop and PGlite would
 * open the data dir as root -- the exact thing this prevents. See
 * privileges.ts for why the fix lives in the process rather than in an
 * ENTRYPOINT or a shell.
 *
 * One constraint this order creates: the listener is bound AFTER the drop, so a
 * PORT below 1024 would now fail where it used to work. Railway injects 8080 and
 * the local default is 4173, so nothing today is affected -- but a privileged
 * port is no longer available to this process, by design.
 *
 * When the container already starts unprivileged (any `docker run` of this
 * image, local `pnpm start`, Windows) dropPrivileges is a no-op and this file
 * costs one extra module load.
 */
import { dropPrivileges } from './privileges';

dropPrivileges({ dataDir: process.env.REIN_CONSOLE_DATA_DIR, log: (m) => console.warn(m) });

await import('./standalone');
