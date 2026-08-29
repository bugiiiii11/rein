# Deploying the Rein Console

The console (`apps/console`) is the only deployed service. It runs on Railway from
the repo-root `Dockerfile`, serving the built Vite UI plus the console API and SSE
stream from one Node process (`apps/console/server/standalone.ts`).

Live at **app.reinconsole.com**. The landing page (`apps/landing`) deploys separately
to Vercel at **reinconsole.com**.

## Build shape

`railway.json` pins the Dockerfile builder, a `/api/state` healthcheck, and
`ON_FAILURE` restarts (max 10). The image is built from the REPO ROOT, not
`apps/console`: the console depends on 10 workspace packages, so the whole
pnpm/Turborepo workspace has to install and build together.

**The Railway service's Root Directory must be the repo root.** Pointing it at
`apps/console` leaves the workspace deps unresolvable.

## Persistence (the volume)

Without `REIN_CONSOLE_DATA_DIR` the console runs fully in memory: every redeploy
reseeds a fresh demo world. With it, the console runs on `@reinconsole/store`
(PGlite) and engine state plus reputation evidence survive restarts. The boot seed
runs once per data directory, so a resumed world does NOT re-seed or replay.

### Dashboard steps

Both settings live in the Railway dashboard, on the service that builds from the
repo-root Dockerfile and serves app.reinconsole.com. Nothing in the repo changes.
They are two halves of one thing and only work as a pair:

- **The variable** is an environment variable the app reads at boot (`standalone.ts`
  passes it to `createWorld`). It says WHERE to put the database.
- **The volume** is Railway's persistent disk. It says WHICH directory survives a
  redeploy. The variable must point INSIDE the volume's mount path.

1. Service -> **Variables** -> **New Variable** -> `REIN_CONSOLE_DATA_DIR` =
   `/data/console`. Railway stages the change; leave it staged.
2. Attach the volume: right-click the service in the project canvas -> **Attach
   Volume**, or service -> **Settings** -> the Volumes section (Railway moves this
   between UI versions; both routes land in the same place). Set the **mount path**
   to `/data` -- absolute, no trailing slash. Not `/data/console`: the variable's
   extra segment is deliberate, see below.
3. Deploy once, applying both staged changes together. Attaching a volume restarts
   the service anyway, so one deploy avoids a needless second restart.

Volumes attach per ENVIRONMENT -- if the project has staging and production, do this
in the one you mean. If no volume option appears at all, it is likely plan-gated.

Confirm from the deploy logs. First boot after attaching the volume:

```
[rein] console world on /data/console: fresh store (seeded)
```

Every boot after that:

```
[rein] console world on /data/console: resumed 11 decisions, 9 reputation subjects,
       3 agents, 1 signer sessions, 7 gate receipts
```

Seeing "fresh store (seeded)" twice in a row means the volume is not actually
mounted where the variable points, and each deploy is writing to container-local
disk that is thrown away.

### Do not set the data dir to the mount path itself

Use a subdirectory (`/data/console`), not `/data`. Railway puts a `lost+found` in
the volume root, and keeping the database in its own directory leaves room for a
second one later without a migration.

Nesting deeper than the mount (`/data/rein/console`) is also fine as of the fix in
`services/store/src/db.ts` — PGlite's own `mkdir` is not recursive and used to throw
ENOENT on boot, which under the `ON_FAILURE` policy is a crash-loop with the cause
buried in the logs. The store now creates parents itself, and a test pins it.

## What survives a restart, and what does not

This split is deliberate and is what the console's stat tiles label (S35/S36):

| Survives | Does not |
|----------|----------|
| Decisions, allow/deny/escalate, chain links | The activity feed (per-process) |
| Registered agents, signer sessions, spend, revocations | `settled` / `shadow` (mock ledger, rebuilt each boot) |
| Gate receipts, revenue, quoted, refusals | `avgLatencyMs` (this process's calls) |
| Reputation evidence and scores | `sigReleased` / `sigRefused` (events, not state) |

Since-boot tiles read "this boot" in the UI. A resumed console showing 0 settled
next to non-zero gate revenue is correct, not a bug.

Session-agent private keys are never persisted: the world rotates them at boot by
design, and identity linking keeps one reputation across the rotation.

## The start command is load-bearing (read before editing `railway.json`)

Two facts about how Railway starts this container, both learned the expensive way:

**1. The start command is run as argv, NOT through a shell.** For Dockerfile/image
deploys Railway execs it directly and it overrides the image's `ENTRYPOINT`. So it
must not be prefixed with `exec` — there is no shell to replace, `exec` is looked up
as a binary, and the container never starts. (Railway's own escape hatch for env-var
expansion is to write the whole thing as `/bin/sh -c "exec ..."`, which we do not
need: `standalone.ts` reads `PORT` from the environment itself.)

**2. Deleting `startCommand` does NOT fall back to the Dockerfile `CMD`.** Railway
substitutes its own inferred pnpm command instead. That is what caused the S36
outage: the deploy log was one line, `No projects matched the filters in "/app"`,
the container never started, and app.reinconsole.com returned 502 for ~15 minutes.
Keep `startCommand` set, and keep it equal to the Dockerfile `CMD`.

Note also that **every push to `main` auto-deploys**, and with a volume attached
Railway stops the old container before starting the new one — so a bad start command
is real downtime, not a failed deploy that quietly rolls back.

## Shutdown

`standalone.ts` handles SIGTERM/SIGINT and drains the store before exiting, because
`world.close()` is the only thing that flushes the write-behind tail. Persist-then-
cache state (signer sessions, spend, revocations, gate replay slots) is acknowledged
on disk and safe regardless; what an un-drained exit loses is up to 30 seconds of
gate receipts and reputation evidence — everything since the last maintenance flush.

### Why it must not start via pnpm

Through S36 the drain never actually ran in production, and the cause was upstream of
its code: the container started via `pnpm --filter @reinconsole/console start`, which
makes **pnpm** the signalled process and node its child. pnpm does not forward
SIGTERM, so node never saw it and was SIGKILLed after the grace period. One cause,
three symptoms: no drain lines in any deployment's log, a brief **"crashed"** status
on every ordinary redeploy (non-zero exit), and a healthy new container seconds later.

The start command therefore invokes node directly. Measured in the real image
(S37, `docker build` + `docker stop`):

| Start command | Exit | Drain |
|---------------|------|-------|
| `pnpm --filter @reinconsole/console start` | non-zero (1, or 137 once SIGKILLed) | none |
| `node apps/console/node_modules/tsx/dist/cli.mjs apps/console/server/standalone.ts` | 0 | drained in <1s |

Either non-zero exit is what a platform reports as "crashed"; neither writes a drain
line. Both forms serve traffic identically, which is why this hid for so long.

Note that the app is still not literally PID 1: **tsx re-spawns it as a child**, so
the boot line reports something like `pid 17`. That is expected and fine — tsx does
forward the signal. "Is the app PID 1?" is the wrong question; the right one is
whether anything in the chain swallows SIGTERM. pnpm does, tsx does not.

The boot line prints the pid for exactly this reason:

```
[rein] console on http://localhost:8080 (pid 17)
[rein] SIGTERM received — draining the store
[rein] store drained, exiting cleanly
```

Those last two lines are the proof the drain ran. **They appear in the OUTGOING
deployment's log, never the incoming one** — Railway logs each deployment separately,
so looking at the Active deployment for shutdown evidence always comes up empty.

**Confirmed in production 2026-08-29:** a Railway redeploy's outgoing log showed the
full sequence — boot, `resumed ... 7 gate receipts`, both drain lines, `Stopping
Container` — with no "crashed" status. The local container matrix above matches the
real deploy exactly.

Ordering matters and is easy to get wrong: `server.close()` on its own waits for open
connections to end, and the console's SSE streams never do, so it must be paired with
`closeAllConnections()` before draining. A 10s backstop force-exits rather than let a
wedged store run past the runtime's kill deadline into a SIGKILL.

An unclean kill is still recoverable — PGlite resumes cleanly from a hard `Stop-Process`
(verified locally, S36); the graceful path exists to save the last flush window, not to
protect the database.

## Verifying a deploy

```
curl -s https://app.reinconsole.com/api/state | jq '.stats'
```

`decisions` and `chainLinks` come from the same signed chain and cannot drift. If
they disagree, something is wrong with the store, not the projection.

### Proving persistence without log access

The counters CANNOT prove it. The boot seed is deterministic, so a world that
reseeded from scratch reports exactly the same 11 decisions / 8-3-0 / $0.07 / 9
subjects as one that resumed. Two deploys in a row showing identical numbers is
not evidence of anything.

The engine's ed25519 signing key is the honest signal: it is generated once and
persisted (`engine_keys`), so it is STABLE across restarts when the volume works
and REGENERATED every boot when it does not.

```
curl -s https://app.reinconsole.com/api/state \
  | jq -r .publicKey | sha256sum | cut -c1-16
```

Record it, redeploy, run it again. Same fingerprint means the store really
resumed. A different one means the service is writing to disposable disk no
matter what the counters say.

