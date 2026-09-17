import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The start command is the most dangerous line in this repo, and until now it
 * was guarded only by prose in DEPLOY.md.
 *
 * S36 cost app.reinconsole.com ~15 minutes of 502s because a start command
 * and the artifact it names disagreed: Railway does not fall back to the
 * Dockerfile CMD when `startCommand` is missing, it substitutes an inferred
 * pnpm command, and the container never started. With a volume attached
 * Railway stops the old container before starting the new one, so this class
 * of mistake is real downtime rather than a failed deploy that rolls back.
 *
 * Every assertion here is about agreement between files that must not drift:
 * the Railway configs, the Dockerfile, and the entry the tests actually
 * exercise. None of them needs a network or a Railway account.
 */
const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const read = (name: string): string => readFileSync(join(repoRoot, name), 'utf8');
const railway = (name: string): { deploy: { startCommand: string; healthcheckPath: string } } =>
  JSON.parse(read(name));

/** The script path out of a `node <path> ...` start command. */
function entryOf(startCommand: string): string {
  const parts = startCommand.split(/\s+/);
  expect(parts[0]).toBe('node');
  const entry = parts.find((p, i) => i > 0 && !p.startsWith('-'));
  expect(entry).toBeDefined();
  return entry as string;
}

describe('deploy configuration', () => {
  describe('the console service (railway.json)', () => {
    const config = railway('railway.json');

    /**
     * The rule DEPLOY.md states and S36 proved prose cannot enforce: the
     * start command and the image's CMD must be the same command. If they
     * drift, the deployed process is not the one the image was built and
     * tested around.
     */
    it('starts the same command the Dockerfile CMD declares', () => {
      const cmd = /^CMD \[(.+)\]$/m.exec(read('Dockerfile'));
      expect(cmd).not.toBeNull();
      const fromDockerfile = JSON.parse(`[${cmd?.[1]}]`) as string[];
      expect(config.deploy.startCommand.split(/\s+/)).toEqual(fromDockerfile);
    });

    it('names an entry that exists in the repo', () => {
      expect(existsSync(join(repoRoot, entryOf(config.deploy.startCommand)))).toBe(true);
    });
  });

  describe('the engine service (railway.engine.json)', () => {
    const config = railway('railway.engine.json');

    /**
     * The deployed entry must be the one the e2e drives. `engine-e2e.ts`
     * spawns `bin/rein-engine.mjs`, so a deploy that booted
     * `dist/server.js` directly would be an untested entry point that merely
     * looks equivalent -- and the bin is what gives a missing build a
     * readable error instead of a module-resolution stack.
     */
    it('starts the same bin the engine e2e spawns', () => {
      const entry = entryOf(config.deploy.startCommand);
      expect(entry).toBe('services/store/bin/rein-engine.mjs');
      expect(read('services/store/src/engine-e2e.ts')).toContain('../bin/rein-engine.mjs');
      expect(existsSync(join(repoRoot, entry))).toBe(true);
    });

    /** The engine answers /health; the console answers /api/health. */
    it('health-checks the path the engine actually serves', () => {
      expect(config.deploy.healthcheckPath).toBe('/health');
      expect(railway('railway.json').deploy.healthcheckPath).toBe('/api/health');
    });

    it('never prefixes the command with exec', () => {
      // Railway runs a start command as argv, not through a shell, so a
      // leading `exec` is looked up as a BINARY and the container never
      // starts -- an outage, versus a lost flush.
      for (const name of ['railway.json', 'railway.engine.json']) {
        expect(railway(name).deploy.startCommand.startsWith('exec ')).toBe(false);
      }
    });

    it('keeps one replica, because the store is single-node', () => {
      const parsed = JSON.parse(read('railway.engine.json')) as {
        deploy: { numReplicas: number };
      };
      expect(parsed.deploy.numReplicas).toBe(1);
    });
  });
  /**
   * S59 found production silently running old code. A push touching only
   * `.github/` and `DEPLOY.md` did not deploy, while the push before it did:
   * the Railway dashboard had Watch Paths set to `apps/console` plus a
   * recursive wildcard. But the image is built from the repo ROOT and bundles
   * ten workspace packages, so that filter meant any push touching only
   * `services/` left production on the previous build with no error anywhere.
   * Sprints 2-4 were mostly `services/` and reached prod only because each
   * also happened to touch a console file.
   *
   * The fix is not a better allowlist. An allowlist fails the DANGEROUS way:
   * a pattern that is subtly wrong, or a directory added a year from now that
   * nobody thinks to add to the list, gives stale production and no signal.
   * So the list starts at `**` and only subtracts, which fails the safe way --
   * a path nobody considered still deploys. It also survives Railway not
   * honouring `!` at all, since the base `**` matches everything on its own
   * and the worst case is then a rebuild nobody needed.
   *
   * Watch paths are gitignore-style patterns (Railway's monorepo guide), so
   * `deploys` below is a minimal gitignore matcher: last pattern to match wins.
   */
  describe('watch patterns (which pushes reach production)', () => {
    const patternsOf = (name: string): string[] =>
      (JSON.parse(read(name)) as { build: { watchPatterns?: string[] } }).build.watchPatterns ?? [];

    /**
     * gitignore-style glob to an anchored RegExp. A `**` segment is held as
     * NUL first so the two cases can be told apart afterwards: as a leading
     * segment it spans zero or more directories, anywhere else it is the rest
     * of the path.
     */
    function toRegExp(pattern: string): RegExp {
      const body = pattern
        .split('/')
        .map((seg) =>
          seg === '**'
            ? '\u0000'
            : seg.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'),
        )
        .join('/')
        .replace(/\u0000\//g, '(?:[^/]+/)*')
        .replace(/\u0000/g, '.*');
      return new RegExp(`^${body}$`);
    }

    /** Would a push whose only changed file is `path` trigger a deploy? */
    function deploys(patterns: string[], path: string): boolean {
      let hit = false;
      for (const p of patterns) {
        const negated = p.startsWith('!');
        if (toRegExp(negated ? p.slice(1) : p).test(path)) hit = !negated;
      }
      return hit;
    }

    it('starts from a match-everything base and only ever subtracts', () => {
      for (const name of ['railway.json', 'railway.engine.json']) {
        const patterns = patternsOf(name);
        expect(patterns.length, `${name} declares no watchPatterns`).toBeGreaterThan(0);
        expect(patterns[0], `${name} must fail safe`).toBe('**');
        expect(patterns.slice(1).every((p) => p.startsWith('!'))).toBe(true);
      }
    });

    /** Both services build the SAME image from the same Dockerfile. */
    it('keeps both services on the same list', () => {
      expect(patternsOf('railway.engine.json')).toEqual(patternsOf('railway.json'));
    });

    /**
     * The anti-drift guard. Every workspace glob in pnpm-workspace.yaml is
     * code that goes into the image, so excluding one -- or adding a workspace
     * root later and quietly leaving it uncovered -- is the S59 bug again.
     */
    it('deploys a change to any workspace package', () => {
      const globs = [...read('pnpm-workspace.yaml').matchAll(/^\s*-\s*'([^']+)'/gm)]
        .map((m) => m[1])
        .filter((g): g is string => g !== undefined);
      expect(globs.length).toBeGreaterThan(0);
      const patterns = patternsOf('railway.json');
      for (const glob of globs) {
        const [root] = glob.split('/');
        expect(deploys(patterns, `${root}/anything/src/index.ts`), `${glob} is not watched`).toBe(
          true,
        );
      }
    });

    it('deploys a change to anything the build itself reads', () => {
      const patterns = patternsOf('railway.json');
      for (const file of [
        'Dockerfile',
        '.dockerignore',
        'package.json',
        'pnpm-lock.yaml',
        'pnpm-workspace.yaml',
        'turbo.json',
        'tsconfig.base.json',
        '.npmrc',
        'railway.json',
        'railway.engine.json',
      ]) {
        expect(deploys(patterns, file), `${file} is not watched`).toBe(true);
      }
    });

    /**
     * The only things deliberately left out, and why none of them can change
     * the running process: docs are prose (the one app that SERVES markdown is
     * apps/landing, which deploys on Vercel, not here), `.github/` is CI,
     * `.claude/` is agent config, and `scripts/` holds the CI package smoke --
     * which the root `build` script never touches.
     */
    it('skips only docs, CI, agent config and CI-only scripts', () => {
      const patterns = patternsOf('railway.json');
      for (const file of [
        'DEPLOY.md',
        'README.md',
        'apps/console/README.md',
        '.github/workflows/ci.yml',
        '.claude/settings.json',
        'scripts/package-smoke.mjs',
      ]) {
        expect(deploys(patterns, file), `${file} should not trigger a deploy`).toBe(false);
      }
      const build = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
        .scripts.build;
      expect(build).not.toContain('scripts/');
    });
  });
});
