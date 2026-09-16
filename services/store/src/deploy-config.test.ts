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
});
