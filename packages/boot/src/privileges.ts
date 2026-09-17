/**
 * Drop from root to an unprivileged user at BOOT, after taking ownership of the
 * data volume.
 *
 * Shared by every Rein service that owns a Railway volume: the console
 * (`apps/console/server/boot.ts`, `/data/console`) and the hosted engine
 * (`services/store/bin/rein-engine.mjs`, `/data/engine`). The engine reaches it
 * through `@reinconsole/store`'s bundled re-export rather than by name, because
 * this package is unpublished and that bin is not -- see this package's README.
 *
 * Why this exists at all. The console's Railway volume was created in S36 by a
 * root container, and an existing volume is never re-initialized from the image,
 * so a `USER node` container hits `EACCES ... mkdir '/data/console'` and
 * crash-loops. A FRESH Railway volume is no better: Railway uses bind mounts and
 * seeds them from nothing, so the engine gets the same failure on its first ever
 * deploy (S59/S60) -- there is no "new service, no history" escape. Two attempts
 * to fix it by hand failed and the second cost ~10 minutes of downtime:
 *
 *   - `chown -R 1000:1000 /data` in the Railway shell DOES succeed, and
 *     `ls -lan` confirms it -- but the OLD root container keeps serving through
 *     the whole ~2 minute build, and every file it creates afterwards lands
 *     `root:root` again. The chown is always stale by the time the new container
 *     starts. That race cannot be won from a shell; it is not a matter of doing
 *     it faster.
 *   - The resulting failure is NOT `EACCES`. PGlite aborts inside its WASM
 *     Postgres (`RuntimeError: Aborted()` at `Object.callMain`), which reads
 *     like a corrupt build rather than a permission problem, and sent S60
 *     looking in the wrong place.
 *
 * So the chown has to happen INSIDE the container that will serve, after the old
 * one is gone (Railway stops the old container before starting the new one when
 * a volume is attached) and before anything opens the database. That is the only
 * moment where no other writer exists -- the race is removed rather than raced.
 *
 * The usual shape of this fix, a root ENTRYPOINT that chowns then `su-exec`s,
 * does not work here: Railway execs `startCommand` as argv and it overrides
 * ENTRYPOINT. Hence a boot module that the start command itself names, dropping
 * privileges IN PROCESS rather than spawning a child -- one process, so the
 * SIGTERM that drains the world still arrives at the server directly, which is
 * the whole reason the start command stopped going through pnpm.
 *
 * Both callers must drop BEFORE the dynamic import of their server. After
 * `setuid` the process cannot regain root, so a database handle already opened
 * as root is the one thing this cannot repair -- and a static import would hoist
 * above the call and do exactly that, silently, because it still works. A test
 * in each service pins that ordering.
 *
 * Fails SOFT on purpose: every failure here leaves the process running as root,
 * which is exactly today's production state, rather than crash-looping a public
 * page. Two outages bought that rule. The result is logged either way, and
 * `deployedAsNode()` is how you check from the outside.
 */
import { chownSync, lchownSync, lstatSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse } from 'node:path';

/** A row of /etc/passwd, which is the only reliable source of `node`'s ids. */
export interface PosixUser {
  readonly name: string;
  readonly uid: number;
  readonly gid: number;
  readonly home: string;
}

/**
 * `node:22-slim` ships `node` as 1000:1000, but the id is an image detail and
 * hardcoding it would fail silently (chown to a uid that owns nothing) if the
 * base image ever renumbered. Parse it; fall back only if the file is unreadable.
 */
export function parsePasswd(text: string, name: string): PosixUser | null {
  for (const line of text.split('\n')) {
    const f = line.split(':');
    if (f[0] !== name || f.length < 6) continue;
    const uid = Number(f[2]);
    const gid = Number(f[3]);
    if (!Number.isInteger(uid) || !Number.isInteger(gid)) continue;
    return { name, uid, gid, home: f[5] || `/home/${name}` };
  }
  return null;
}

export interface ChownDeps {
  readonly chown: (path: string, uid: number, gid: number) => void;
  readonly lchown: (path: string, uid: number, gid: number) => void;
  readonly readdir: (path: string) => { name: string; isDirectory: () => boolean }[];
  readonly isDir: (path: string) => boolean;
}

const realDeps: ChownDeps = {
  chown: chownSync,
  lchown: lchownSync,
  readdir: (path) => readdirSync(path, { withFileTypes: true }),
  isDir: (path) => lstatSync(path).isDirectory(),
};

/**
 * `chown -R`, depth-first, symlinks chowned rather than followed (a symlink in
 * the data dir must not let a chown escape it). Returns how many paths changed.
 */
export function chownTree(root: string, uid: number, gid: number, deps = realDeps): number {
  let count = 0;
  const walk = (path: string, directory: boolean): void => {
    if (directory) for (const e of deps.readdir(path)) walk(join(path, e.name), e.isDirectory());
    // The directory itself comes last: chowning it first would be undone by
    // nothing, but doing it last means a partial failure leaves the parent
    // root-owned and the next boot retries the whole tree.
    if (directory) deps.chown(path, uid, gid);
    else deps.lchown(path, uid, gid);
    count += 1;
  };
  walk(root, deps.isDir(root));
  return count;
}

export type DropOutcome =
  | { readonly dropped: false; readonly reason: 'not-root' | 'no-such-user' | 'failed' }
  | { readonly dropped: true; readonly user: PosixUser; readonly chowned: number };

export interface DropOptions {
  /** The volume path whose ownership must move with us. Undefined = ephemeral world. */
  readonly dataDir?: string | undefined;
  /** Username to become. Overridable for images that do not ship `node`. */
  readonly user?: string;
  readonly log?: (message: string) => void;
}

/**
 * Take ownership of the data dir, then become `node`. Never throws.
 *
 * Call before ANYTHING opens the database: after `setuid` the process cannot
 * regain root, so an already-open root-owned file handle would be the one thing
 * this cannot repair.
 */
export function dropPrivileges(options: DropOptions = {}): DropOutcome {
  const log = options.log ?? ((m: string): void => console.warn(m));
  const name = options.user ?? process.env.REIN_RUN_AS_USER ?? 'node';

  // getuid is undefined on Windows, and 0 is the only value worth acting on.
  if (process.getuid?.() !== 0) return { dropped: false, reason: 'not-root' };

  let user: PosixUser | null = null;
  try {
    user = parsePasswd(readFileSync('/etc/passwd', 'utf8'), name);
  } catch {
    user = null;
  }
  if (!user) {
    log(`[rein] WARNING: no user '${name}' in /etc/passwd — staying root.`);
    return { dropped: false, reason: 'no-such-user' };
  }

  let chowned = 0;
  try {
    if (options.dataDir !== undefined && options.dataDir !== '') {
      // recursive:true is a no-op when the dir exists, which is the common case;
      // it matters on a FRESH volume, where the first process to create the dir
      // decides its owner. Doing it here means that process is always this one.
      mkdirSync(options.dataDir, { recursive: true });
      const parent = dirname(options.dataDir);
      // The mount point itself, so a future boot can recreate the dir after a
      // wipe without root. Skipped at the filesystem root, where it would mean
      // handing `/` to node.
      if (isAbsolute(options.dataDir) && parent !== parse(parent).root) {
        chownSync(parent, user.uid, user.gid);
        chowned += 1;
      }
      chowned += chownTree(options.dataDir, user.uid, user.gid);
    }

    // Order is load-bearing: supplementary groups and gid must go while still
    // root, because setuid is the door that locks behind you.
    process.setgroups?.([user.gid]);
    process.setgid?.(user.gid);
    process.setuid?.(user.uid);

    // HOME still says /root otherwise, and anything that caches under it (tsx,
    // npm, any library's dot-dir) would hit EACCES far from here.
    process.env.HOME = user.home;
    process.env.USER = user.name;
    process.env.LOGNAME = user.name;
  } catch (error) {
    // Reached either with the chown half-done or, much less likely, mid-setuid.
    // Either way the safe state is the one we are already in: root, serving.
    log(
      `[rein] WARNING: could not drop to '${name}' (${String(error)}) — staying root. ` +
        `The site is up; the data dir may still be root-owned.`,
    );
    return { dropped: false, reason: 'failed' };
  }

  log(
    `[rein] dropped root -> ${user.name} (${user.uid}:${user.gid}), ` +
      `${chowned} path(s) chowned in ${options.dataDir ?? '(no data dir)'}`,
  );
  return { dropped: true, user, chowned };
}
