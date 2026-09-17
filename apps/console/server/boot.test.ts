import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

/**
 * The deploy triple that S36 proved prose cannot hold together: railway.json's
 * startCommand, the Dockerfile CMD, and the file on disk. services/store's
 * deploy-config.test.ts pins the first two against each other; this pins the
 * one thing it cannot see -- that the deployed entry is the one that drops
 * root, not standalone.ts directly.
 *
 * The drop itself lives in @reinconsole/boot and is tested there. What is
 * console-specific, and what this file exists for, is the ORDER in this app's
 * boot.ts and the fact that the deployment actually names it.
 */
describe('the deployed entry point', () => {
  const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
  const read = (name: string): string => readFileSync(join(repoRoot, name), 'utf8');

  it('boots the console through boot.ts', () => {
    const startCommand = (JSON.parse(read('railway.json')) as { deploy: { startCommand: string } })
      .deploy.startCommand;
    expect(startCommand.endsWith('apps/console/server/boot.ts')).toBe(true);
    expect(read('Dockerfile')).toContain('apps/console/server/boot.ts');
  });

  it('keeps the privilege drop above the server import', () => {
    const boot = read('apps/console/server/boot.ts');
    // A static import of ./standalone would hoist above the drop and open the
    // database as root -- silently, since it would still work.
    expect(/^import .*['"]\.\/standalone['"]/m.test(boot)).toBe(false);
    const drop = boot.indexOf('dropPrivileges(');
    const server = boot.indexOf("import('./standalone')");
    // Both found FIRST: indexOf gives -1 for a missing call and -1 is less than
    // every index, so the ordering assertion alone would go green on a boot.ts
    // that had dropped the drop.
    expect(drop, 'boot.ts no longer drops privileges').toBeGreaterThan(-1);
    expect(server, 'boot.ts no longer imports standalone').toBeGreaterThan(-1);
    expect(drop).toBeLessThan(server);
  });
});
