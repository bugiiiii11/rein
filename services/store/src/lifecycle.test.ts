import { afterEach, describe, expect, it, vi } from 'vitest';
import { installShutdown, pruneIntervalFromEnv, startPeriodicPrune } from './lifecycle.js';

/** A3: what the durable bins do when the runtime says stop. */

const installed: Array<{ uninstall: () => void }> = [];

afterEach(() => {
  for (const i of installed.splice(0)) i.uninstall();
  vi.useRealTimers();
});

function install(options: Parameters<typeof installShutdown>[0]) {
  const handle = installShutdown(options);
  installed.push(handle);
  return handle;
}

describe('installShutdown', () => {
  it('drains, reports it, and sets a zero exit code', async () => {
    const log: string[] = [];
    const exits: number[] = [];
    let drained = false;
    const handle = install({
      name: 'test-bin',
      close: async () => {
        drained = true;
      },
      signals: [],
      log: (m) => log.push(m),
      exit: (c) => exits.push(c),
    });

    await handle.shutdown('SIGTERM');
    expect(drained).toBe(true);
    expect(log.join('\n')).toContain('store drained, exiting cleanly');
    expect(process.exitCode).toBe(0);
    // NOT exited yet: stdout to a container log pipe is async, and exiting on
    // the spot truncates the line that is the only evidence the drain ran.
    expect(exits).toEqual([]);
    process.exitCode = 0;
  });

  it('a second signal joins the first drain instead of racing it', async () => {
    // Which is what a runtime does when a shutdown looks slow to it.
    let closes = 0;
    const handle = install({
      name: 'test-bin',
      close: async () => {
        closes += 1;
        await new Promise((r) => setTimeout(r, 20));
      },
      signals: [],
      log: () => undefined,
      exit: () => undefined,
    });

    await Promise.all([handle.shutdown('SIGTERM'), handle.shutdown('SIGTERM'), handle.shutdown('SIGINT')]);
    expect(closes).toBe(1);
    process.exitCode = 0;
  });

  it('a failed drain is reported and exits non-zero — a clean shutdown may not lie', async () => {
    const errors: string[] = [];
    const handle = install({
      name: 'test-bin',
      close: async () => {
        throw new Error('flush exploded');
      },
      signals: [],
      log: () => undefined,
      error: (m) => errors.push(m),
      exit: () => undefined,
    });

    await handle.shutdown('SIGTERM');
    expect(errors.join('\n')).toContain('drain failed');
    expect(process.exitCode).toBe(1);
    process.exitCode = 0;
  });

  it('a wedged store does not hold the container past the kill deadline', async () => {
    // Without the backstop an orderly flush becomes the SIGKILL it was trying
    // to avoid, and the deploy looks identical to one that drained.
    vi.useFakeTimers();
    const errors: string[] = [];
    const exits: number[] = [];
    const handle = install({
      name: 'test-bin',
      close: () => new Promise<void>(() => undefined), // never settles
      signals: [],
      timeoutMs: 1_000,
      log: () => undefined,
      error: (m) => errors.push(m),
      exit: (c) => exits.push(c),
    });

    void handle.shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_100);
    expect(errors.join('\n')).toContain('drain timed out');
    expect(exits).toEqual([1]);
  });

  it('listens on the signals a container actually sends', async () => {
    const before = process.listenerCount('SIGTERM');
    const handle = install({
      name: 'test-bin',
      close: async () => undefined,
      log: () => undefined,
      exit: () => undefined,
    });
    expect(process.listenerCount('SIGTERM')).toBe(before + 1);
    handle.uninstall();
    expect(process.listenerCount('SIGTERM')).toBe(before);
  });
});

describe('startPeriodicPrune', () => {
  it('sweeps on the interval and stops when told', async () => {
    vi.useFakeTimers();
    let sweeps = 0;
    const stop = startPeriodicPrune({
      prune: async () => {
        sweeps += 1;
      },
      intervalMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(3_100);
    expect(sweeps).toBe(3);
    stop();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(sweeps).toBe(3);
  });

  it('a failed sweep is logged and the schedule survives it', async () => {
    // Pruning is housekeeping over rows that are already dead. A transient
    // failure is not a reason to stop serving, or to stop sweeping.
    vi.useFakeTimers();
    const errors: unknown[] = [];
    let attempts = 0;
    const stop = startPeriodicPrune({
      prune: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('db busy');
      },
      intervalMs: 1_000,
      error: (e) => errors.push(e),
    });
    await vi.advanceTimersByTimeAsync(2_100);
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
    stop();
  });

  it('interval 0 installs no timer at all', async () => {
    vi.useFakeTimers();
    let sweeps = 0;
    const stop = startPeriodicPrune({
      prune: async () => {
        sweeps += 1;
      },
      intervalMs: 0,
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(sweeps).toBe(0);
    stop();
  });
});

describe('pruneIntervalFromEnv', () => {
  it('defaults to 30 minutes and takes 0 as off', () => {
    expect(pruneIntervalFromEnv({})).toBe(30 * 60_000);
    expect(pruneIntervalFromEnv({ REIN_PRUNE_INTERVAL_MS: '0' })).toBe(0);
    expect(pruneIntervalFromEnv({ REIN_PRUNE_INTERVAL_MS: '60000' })).toBe(60_000);
  });

  it('refuses a garbage value rather than silently sweeping on its own schedule', () => {
    expect(() => pruneIntervalFromEnv({ REIN_PRUNE_INTERVAL_MS: 'often' })).toThrow(
      /non-negative/,
    );
    expect(() => pruneIntervalFromEnv({ REIN_PRUNE_INTERVAL_MS: '-1' })).toThrow(/non-negative/);
  });
});
