/**
 * Graceful shutdown for the durable bins.
 *
 * Every container runtime stops a deploy with SIGTERM and kills what is left a
 * few seconds later. Until this existed, the persistent services simply died
 * there: `store.close()` never ran, so the write-behind tail — reputation
 * evidence, gate telemetry, API-key usage — was lost on every single redeploy,
 * silently, because nothing about a SIGKILLed process says a flush was owed.
 * Persist-then-cache state (spend, sessions, decisions, keys) is acknowledged
 * on disk as it happens and survives either way; what a drain saves is the
 * tail, and the difference is invisible until somebody asks why the numbers
 * moved backwards after a deploy.
 *
 * This is `apps/console/server/standalone.ts`'s shutdown, generalized: that
 * one was written first and proved in the Railway image (the pnpm start
 * command was SIGKILLed with no drain lines; `node` directly exits 0 after
 * draining — see the Dockerfile comment). The console keeps its own copy
 * because it closes a `World` and cuts SSE streams, neither of which a bin has.
 *
 * Three properties the callers depend on:
 *
 * - IDEMPOTENT. A second signal during a drain is ignored rather than racing
 *   the first, which is what a runtime does when a shutdown looks slow.
 * - BOUNDED. A wedged store must not hold the container open past the
 *   runtime's kill deadline; that turns an orderly flush into the SIGKILL it
 *   was trying to avoid. The backstop exits non-zero, so a deploy that could
 *   not drain is visible rather than silently identical to one that did.
 * - QUIET ON THE WAY OUT. `process.exit()` is NOT called on the success path.
 *   stdout to a container's log pipe is asynchronous, and exiting immediately
 *   truncates the very line that is the only evidence the drain happened.
 */

/** How long a drain may take before the process gives up and exits non-zero. */
const DRAIN_TIMEOUT_MS = 10_000;
/** Grace for the final log line to reach the container's pipe before exiting. */
const LOG_FLUSH_MS = 2_000;

export interface ShutdownOptions {
  /**
   * What to close, in order. Each runs once, and a rejection is reported
   * rather than swallowed: a shutdown that lies about being clean is worse
   * than one that admits it failed.
   */
  close: () => Promise<void>;
  /** Named in the log lines, e.g. `rein-engine`. */
  name: string;
  /** Signals to install for. Defaults to SIGTERM + SIGINT. */
  signals?: NodeJS.Signals[];
  /** Overridable for tests. */
  timeoutMs?: number;
  log?: (message: string) => void;
  error?: (message: string, err?: unknown) => void;
  /** Overridable for tests; defaults to `process.exit`. */
  exit?: (code: number) => void;
}

export interface InstalledShutdown {
  /** Run the drain as if a signal had arrived (tests, and an explicit stop). */
  shutdown(reason: string): Promise<void>;
  /** Remove the signal handlers. Does not drain. */
  uninstall(): void;
}

export function installShutdown(options: ShutdownOptions): InstalledShutdown {
  const name = options.name;
  const log = options.log ?? ((message: string) => console.log(message));
  const fail = options.error ?? ((message: string, err?: unknown) => console.error(message, err));
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const timeoutMs = options.timeoutMs ?? DRAIN_TIMEOUT_MS;
  const signals = options.signals ?? (['SIGTERM', 'SIGINT'] as NodeJS.Signals[]);

  let draining: Promise<void> | undefined;

  const shutdown = (reason: string): Promise<void> => {
    // A second signal joins the first drain instead of starting another one.
    if (draining) return draining;
    draining = (async () => {
      log(`[rein] ${name}: ${reason} received — draining the store`);
      const abandon = setTimeout(() => {
        fail(`[rein] ${name}: drain timed out after ${timeoutMs} ms — exiting with data unflushed`);
        exit(1);
      }, timeoutMs);
      // Unref'd: the backstop must never be the reason the process stays alive.
      abandon.unref?.();
      try {
        await options.close();
        clearTimeout(abandon);
        log(`[rein] ${name}: store drained, exiting cleanly`);
        process.exitCode = 0;
        // Deliberately not process.exit(0): see the file comment. The server
        // and store are closed, so the loop ends on its own; this unref'd
        // timer only forces the issue if some other handle lingers.
        setTimeout(() => exit(0), LOG_FLUSH_MS).unref?.();
      } catch (err) {
        clearTimeout(abandon);
        fail(`[rein] ${name}: drain failed (unflushed telemetry may be lost):`, err);
        process.exitCode = 1;
        setTimeout(() => exit(1), LOG_FLUSH_MS).unref?.();
      }
    })();
    return draining;
  };

  const handlers = new Map<NodeJS.Signals, () => void>();
  for (const signal of signals) {
    const handler = () => void shutdown(signal);
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return {
    shutdown,
    uninstall: () => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      handlers.clear();
    },
  };
}

/** Default gap between periodic prunes on a long-lived server. */
const PRUNE_INTERVAL_MS = 30 * 60_000;

export interface PruneOptions {
  prune: () => Promise<unknown>;
  /** `REIN_PRUNE_INTERVAL_MS`; 0 turns the timer off. Default 30 minutes. */
  intervalMs?: number;
  error?: (err: unknown) => void;
}

/**
 * Prune the TTL'd burn tables on a schedule, and return the stop function.
 *
 * `openReinStore` prunes once at open, which covers a service that restarts
 * often and leaves one that does not accreting replay slots and voucher burns
 * for as long as it stays up — precisely backwards, since the whole point of
 * the durable bins is to stay up. The timer is UNREF'd: a maintenance sweep
 * must never be the reason a process refuses to exit, and shutdown stops it
 * explicitly anyway.
 *
 * A failed sweep is logged and the schedule continues. Pruning is housekeeping
 * over rows that are already dead; a transient error there is not a reason to
 * stop serving, and it will be retried in half an hour regardless.
 */
export function startPeriodicPrune(options: PruneOptions): () => void {
  const intervalMs = options.intervalMs ?? PRUNE_INTERVAL_MS;
  if (intervalMs <= 0) return () => undefined;
  const onError = options.error ?? ((err: unknown) => console.error('[rein] prune failed:', err));
  const timer = setInterval(() => {
    void options.prune().catch(onError);
  }, intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** `REIN_PRUNE_INTERVAL_MS`, or the 30-minute default. `0` disables pruning. */
export function pruneIntervalFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env['REIN_PRUNE_INTERVAL_MS']?.trim();
  if (!raw) return PRUNE_INTERVAL_MS;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(
      `REIN_PRUNE_INTERVAL_MS must be a non-negative number of milliseconds, got ${JSON.stringify(raw)}. ` +
        'Use 0 to disable periodic pruning.',
    );
  }
  return value;
}
