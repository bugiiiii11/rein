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

1. Service -> **Variables** -> add `REIN_CONSOLE_DATA_DIR = /data/console`.
2. Service -> **Volumes** -> attach a volume with **mount path `/data`**.
3. Redeploy.

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

## Shutdown

`standalone.ts` handles SIGTERM/SIGINT and drains the store before exiting, because
`world.close()` is the only thing that flushes the write-behind tail. Persist-then-
cache state (signer sessions, spend, revocations, gate replay slots) is acknowledged
on disk and safe regardless; what an un-drained exit loses is up to 30 seconds of
gate receipts and reputation evidence — everything since the last maintenance flush.

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
