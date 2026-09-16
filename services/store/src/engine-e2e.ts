/**
 * The measuring instrument behind `engine.e2e.test.ts` and its live twin.
 *
 * It runs the DEPLOYABLE engine -- `bin/rein-engine.mjs`, the file that
 * `npx rein-engine` and the hosted service start, not an in-process
 * `buildServer()` -- as a child process on a throwaway data directory, and
 * hands back what an external agent gets: a URL and an admin secret. Every
 * other step of the e2e (register, guard, pay, reconcile, restart) then goes
 * through the public HTTP surface exactly as an outside SDK does. That is the
 * point: this is the first test in the repo that fails if the bin, the boot
 * line, the env contract or the wire changes while every in-process test
 * stays green.
 *
 * `REIN_E2E_ENGINE_URL` retargets the same test at an engine that is already
 * running (Sprint 4 points it at the hosted one); `REIN_ENGINE_API_KEY` is
 * then the admin secret to use. Restart coverage is skipped there -- a remote
 * engine is not ours to kill.
 *
 * The bin needs `dist/server.js`: `services/store/turbo.json` makes the
 * package's own `build` a dependency of its `test`, so `pnpm test` from the
 * root is self-sufficient. Running vitest directly needs a `pnpm build` first.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BIN = fileURLToPath(new URL('../bin/rein-engine.mjs', import.meta.url));
/** The boot line names the BOUND port, which is how PORT=0 is discoverable. */
const BOOT_LINE = /policy-engine listening on (http:\/\/[^\s]+)/;
const BOOT_TIMEOUT_MS = 60_000;
const EXIT_TIMEOUT_MS = 10_000;

export interface EngineUnderTest {
  /** Base URL of the engine. Stable across `restart()`: the same port is reused. */
  readonly url: string;
  /** The operator secret (`REIN_ENGINE_API_KEY`), with every scope. */
  readonly adminSecret: string;
  /** False when `REIN_E2E_ENGINE_URL` pointed the test at an engine we do not own. */
  readonly local: boolean;
  /**
   * SIGTERM the child and wait for it to exit, reporting how it went. This is
   * the only place the SHUTDOWN path is observable: the drain lines go to the
   * child's stdout and the exit code says whether the backstop fired.
   * A remote engine is not ours to kill, so this reports nothing.
   */
  stop(): Promise<ExitReport>;
  /** Start the child again on the SAME data dir and port. Throws for a remote engine. */
  restart(): Promise<void>;
  /** Stop the child and delete its data dir. */
  dispose(): Promise<void>;
}

/** How a child engine went away, for the SIGTERM-drain assertion. */
export interface ExitReport {
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Everything the child wrote to stdout and stderr, boot line onwards. */
  output: string;
}

interface Child {
  process: ChildProcess;
  url: string;
  /** Accumulates for the child's whole life, not just until it listened. */
  log: string[];
}

export async function engineUnderTest(): Promise<EngineUnderTest> {
  const remote = process.env['REIN_E2E_ENGINE_URL']?.trim();
  if (remote) {
    const adminSecret = process.env['REIN_ENGINE_API_KEY']?.trim();
    if (!adminSecret) {
      throw new Error(
        'REIN_E2E_ENGINE_URL is set but REIN_ENGINE_API_KEY (its admin secret) is not',
      );
    }
    return {
      url: remote.replace(/\/+$/, ''),
      adminSecret,
      local: false,
      stop: async () => ({ code: null, signal: null, output: '' }),
      restart: async () => {
        throw new Error('a remote engine is not ours to restart');
      },
      dispose: async () => undefined,
    };
  }

  const dir = mkdtempSync(join(tmpdir(), 'rein-e2e-'));
  const adminSecret = `e2e-${randomBytes(16).toString('hex')}`;
  let child = await boot(dir, adminSecret, 0);
  const port = Number(new URL(child.url).port);
  return {
    get url() {
      return child.url;
    },
    adminSecret,
    local: true,
    stop: () => stop(child),
    restart: async () => {
      await stop(child);
      // Same data dir, same port: the deployment this stands in for keeps
      // both across a restart. One retry covers the OS still releasing the
      // listener the killed process held.
      try {
        child = await boot(dir, adminSecret, port);
      } catch {
        await sleep(500);
        child = await boot(dir, adminSecret, port);
      }
    },
    dispose: async () => {
      await stop(child);
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // best-effort: a stray temp dir is harmless
      }
    },
  };
}

/** Poll `read` until `done` accepts its value or `ms` elapse; returns the last value either way. */
export async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  ms = 10_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last = await read();
  while (!done(last) && Date.now() < deadline) {
    await sleep(100);
    last = await read();
  }
  return last;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function boot(dir: string, adminSecret: string, port: number): Promise<Child> {
  // A hermetic environment: the developer's own REIN_* settings (a Telegram
  // token, an external signing key) must not leak into the engine under test.
  const env: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('REIN_')),
  );
  Object.assign(env, {
    REIN_DATA_DIR: dir,
    PORT: String(port),
    HOST: '127.0.0.1',
    REIN_ENGINE_API_KEY: adminSecret,
  });
  const proc = spawn(process.execPath, [BIN], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  proc.stdout!.setEncoding('utf8');
  proc.stderr!.setEncoding('utf8');

  const log: string[] = [];
  const url = await new Promise<string>((resolve, reject) => {
    const fail = (why: string) =>
      reject(new Error(`${why}\n--- engine output ---\n${log.join('')}`));
    const timer = setTimeout(() => {
      proc.kill();
      fail(`the engine printed no boot line within ${BOOT_TIMEOUT_MS} ms`);
    }, BOOT_TIMEOUT_MS);
    let seen = '';
    let listening = false;
    proc.stdout!.on('data', (chunk: string) => {
      log.push(chunk);
      if (listening) return;
      seen += chunk;
      const match = BOOT_LINE.exec(seen);
      if (match) {
        listening = true;
        clearTimeout(timer);
        resolve(match[1]!);
      }
    });
    proc.stderr!.on('data', (chunk: string) => log.push(chunk));
    proc.once('exit', (code, signal) => {
      clearTimeout(timer);
      fail(`the engine exited before it listened (code ${code}, signal ${signal})`);
    });
    proc.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
  return { process: proc, url, log };
}

async function stop(child: Child): Promise<ExitReport> {
  const proc = child.process;
  if (proc.exitCode !== null || proc.signalCode !== null) {
    return { code: proc.exitCode, signal: proc.signalCode, output: child.log.join('') };
  }
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.once('exit', (code, signal) => resolve({ code, signal })),
  );
  proc.kill('SIGTERM');
  const forced = setTimeout(() => proc.kill('SIGKILL'), EXIT_TIMEOUT_MS);
  const { code, signal } = await exited;
  clearTimeout(forced);
  // The exit event can beat the last stdout chunk to the event loop, and the
  // drain line is the last thing written — give the pipe a tick to flush or
  // the assertion races the evidence it is looking for.
  await sleep(50);
  return { code, signal, output: child.log.join('') };
}
