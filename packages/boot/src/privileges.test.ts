import { describe, it, expect } from 'vitest';
import { chownTree, dropPrivileges, parsePasswd, type ChownDeps } from './privileges';

/**
 * These run unprivileged (and on Windows), so the syscalls are injected. What
 * can be pinned without root is the part that was actually wrong twice: which
 * paths get chowned, in which order, and that nothing here can crash a boot.
 */
describe('parsePasswd', () => {
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash',
    'daemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin',
    'node:x:1000:1000::/home/node:/bin/bash',
    '',
  ].join('\n');

  it('reads the ids and home of the named user', () => {
    expect(parsePasswd(passwd, 'node')).toEqual({
      name: 'node',
      uid: 1000,
      gid: 1000,
      home: '/home/node',
    });
  });

  it('does not match a user whose name merely starts the same', () => {
    expect(parsePasswd('nodejs:x:1001:1001::/home/nodejs:/bin/sh', 'node')).toBeNull();
  });

  it('returns null rather than guessing when the user is absent', () => {
    expect(parsePasswd(passwd, 'app')).toBeNull();
  });

  /** A blank home field is legal in /etc/passwd; a chown target of '' is not. */
  it('substitutes a home when the field is empty', () => {
    expect(parsePasswd('node:x:1000:1000:::/bin/sh', 'node')?.home).toBe('/home/node');
  });

  it('ignores a row whose ids are not numbers', () => {
    expect(parsePasswd('node:x:x:y::/home/node:/bin/sh', 'node')).toBeNull();
  });
});

describe('chownTree', () => {
  /** /data/console as PGlite leaves it: nested dirs, files, and a symlink. */
  const tree: Record<string, { name: string; isDirectory: () => boolean }[]> = {
    '/data/console': [
      { name: 'base', isDirectory: (): boolean => true },
      { name: 'PG_VERSION', isDirectory: (): boolean => false },
    ],
    '/data/console/base': [{ name: '1', isDirectory: (): boolean => false }],
  };

  const spy = (): { deps: ChownDeps; chowned: string[]; lchowned: string[] } => {
    const chowned: string[] = [];
    const lchowned: string[] = [];
    return {
      chowned,
      lchowned,
      deps: {
        chown: (p) => void chowned.push(p.replace(/\\/g, '/')),
        lchown: (p) => void lchowned.push(p.replace(/\\/g, '/')),
        readdir: (p) => tree[p.replace(/\\/g, '/')] ?? [],
        isDir: (p) => p.replace(/\\/g, '/') in tree,
      },
    };
  };

  it('reaches every file and directory under the root', () => {
    const { deps, chowned, lchowned } = spy();
    const count = chownTree('/data/console', 1000, 1000, deps);
    expect(lchowned).toEqual(['/data/console/base/1', '/data/console/PG_VERSION']);
    expect(chowned).toEqual(['/data/console/base', '/data/console']);
    expect(count).toBe(4);
  });

  /**
   * Depth first, parents last: a run that dies halfway leaves the root still
   * root-owned, so the next boot retries instead of declaring success over a
   * half-chowned volume.
   */
  it('chowns a directory only after its contents', () => {
    const { deps, chowned, lchowned } = spy();
    chownTree('/data/console', 1000, 1000, deps);
    expect(chowned.indexOf('/data/console')).toBe(chowned.length - 1);
    expect(lchowned).not.toContain('/data/console');
  });

  it('chowns symlinks without following them', () => {
    const { deps, lchowned, chowned } = spy();
    chownTree('/data/console/PG_VERSION', 1000, 1000, deps);
    expect(lchowned).toEqual(['/data/console/PG_VERSION']);
    expect(chowned).toEqual([]);
  });
});

describe('dropPrivileges', () => {
  /**
   * The suite never runs as root, which is the branch that matters for every
   * developer machine and for `docker run` of this image: do nothing, say
   * nothing, cost nothing.
   */
  it('is a silent no-op when the process is not root', () => {
    const lines: string[] = [];
    expect(dropPrivileges({ dataDir: '/data/console', log: (m) => lines.push(m) })).toEqual({
      dropped: false,
      reason: 'not-root',
    });
    expect(lines).toEqual([]);
  });

  it('leaves the real process ids untouched', () => {
    const before = process.getuid?.();
    dropPrivileges({ log: () => {} });
    expect(process.getuid?.()).toBe(before);
  });
});
