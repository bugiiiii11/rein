# Deploying the Rein Console

The console (`apps/console`) is the only deployed service. It runs on Railway from
the repo-root `Dockerfile`, serving the built Vite UI plus the console API and SSE
stream from one Node process (`apps/console/server/standalone.ts`, entered through
`boot.ts`, which drops root first -- see "The fix that ships (S61)" below).

Live at **app.reinconsole.com**. The landing page (`apps/landing`) deploys separately
to Vercel at **reinconsole.com**.

## Build shape

`railway.json` pins the Dockerfile builder, a `/api/health` healthcheck (liveness only --
it reads no world state, so a probe is not a free snapshot), and
`ON_FAILURE` restarts (max 10). The image is built from the REPO ROOT, not
`apps/console`: the console depends on 10 workspace packages, so the whole
pnpm/Turborepo workspace has to install and build together.

**The Railway service's Root Directory must be the repo root.** Pointing it at
`apps/console` leaves the workspace deps unresolvable.

## Which pushes deploy (watch patterns, S60)

`railway.json` now owns the deploy trigger, in `build.watchPatterns`. Before S60 it
lived only in the dashboard as Watch Paths, set to `apps/console/**`, and that was
wrong in a way nothing reported: the image is built from the repo ROOT, so a push
touching only `services/**` produced no deploy at all and left production running the
previous build. Sprints 2-4 were mostly `services/**` and reached prod only because
each one also happened to touch a console file. S59 noticed only because a
`.github/`-and-docs push failed to deploy when a deploy was expected.

The list is deliberately subtractive:

```json
"watchPatterns": ["**", "!**/*.md", "!.github/**", "!.claude/**", "!scripts/**"]
```

An allowlist fails the DANGEROUS way -- anything nobody remembered to list stops
deploying, silently, which is exactly what happened. A base of `**` minus known-inert
paths fails the safe way: a path nobody considered still deploys, and the worst case
is a rebuild nobody needed. It also survives Railway not honouring `!` at all, since
`**` matches everything on its own.

Left out, and why none of them can change the running process: markdown is prose (the
one app that SERVES `.md` is `apps/landing`, which deploys on Vercel, not here),
`.github/` is CI, `.claude/` is agent config, and `scripts/` holds the CI package
smoke, which the root `build` script never runs.

`deploy-config.test.ts` pins all of this, and derives the workspace roots from
`pnpm-workspace.yaml` -- so adding a fourth workspace glob and forgetting the watch
list fails the suite instead of failing production.

**Founder steps, once.** Two things about how this lands:

1. Railway's own rule is that "configuration defined in code will always override
   values from the dashboard", and that "the settings in the dashboard will not be
   updated with the settings defined in code" -- from which S60 predicted the
   Settings -> Build panel would KEEP displaying the old `apps/console/**` forever.
   **Observed 2026-09-17 (S61): it does not.** Once a deploy has read the new
   `railway.json`, the panel shows the file's list under a "The value is set in
   /railway.json" banner and the old dashboard value is gone. There is nothing to
   clear by hand. The quoted rule is about PRECEDENCE, not about what is rendered.

   What that banner is genuinely useful for is spotting the opposite case: a field
   WITHOUT it is a dashboard-only override that no file governs and no test can
   see. The console had one -- Custom Build Command `pnpm --filter @rein/console
   build`, naming a package that does not exist (it is `@reinconsole/console`).
   Inert, because custom build commands apply to Nixpacks/Railpack builds and this
   service builds from a Dockerfile -- but it is the S36 error message (`No projects
   matched the filters in "/app"`) sitting one builder change away from production.
2. The commit that introduces this cannot deploy itself. Until a deploy actually
   reads the new `railway.json`, the old dashboard filter is still deciding, and a
   commit touching `railway.json`, `DEPLOY.md` and `services/` does not match
   `apps/console/**`. **Trigger one MANUAL redeploy after pushing it** -- Deployments
   -> the latest commit -> Redeploy. Everything after that is automatic.

Confirm it took: push any `services/`-only change and watch a deploy start.

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

**3. An EMPTY start command falls back to the image `CMD` — and the `CMD` is the
console.** This is not the same as fact 2 and it bites harder. Fact 2 is what S36
saw on the console service, which is governed by `railway.json`; the engine service
is dashboard-configured (Config as Code cannot be opted into for a service created
after 2026-08-28, S65), and when its Custom Start Command field was empty Railway ran
the image's `CMD` instead. From 2026-09-19 to 2026-09-21 `engine.reinconsole.com`
therefore served the CONSOLE.

Nothing caught it for two days, and nothing structurally could have:

- The console answers any unmatched path with its SPA at **status 200**, `/health`
  included, so Railway's healthcheck passed and the deploy was green and "Online".
- There is no healthcheck path that fixes this. The console 404s nothing.
- The only symptom was the nightly backup and the live run failing on a JSON parse
  error — and `backup.yml` had no alarm at the time, so nobody was told.

Since no probe can tell the two apart, the check lives in the process:
`checkServiceIdentity` in `@reinconsole/boot`, called by `apps/console/server/boot.ts`
and `apps/vendor/src/index.ts` before anything binds a port. It refuses to start when
it finds a marker belonging to a different service — `REIN_ENGINE_SIGNING_KEY` (the
engine) or `REIN_VENDOR_PAY_TO` (the vendor) — both of which are variables the owning
service cannot run without, chosen for exactly that reason: a variable that must be
SET cannot detect configuration going missing.

**This cannot fire on app.reinconsole.com**, whose environment has neither marker, so
the console's deliberate fail-soft posture (S61) is intact; the only process it can
stop is one already serving the wrong thing. If one environment genuinely hosts two
services, set `REIN_ALLOW_FOREIGN_SERVICE_ENV=1`.

Note also that **every push to `main` auto-deploys**, and with a volume attached
Railway stops the old container before starting the new one — so a bad start command
is real downtime, not a failed deploy that quietly rolls back.

**CORRECTION (S59, 2026-09-17): everything in point 3 below is superseded. Do NOT
follow it.** Recreating the volume does not make the container run as `node`, and the
attempt cost a live outage. Two things were wrong:

- **The S57 measurement does not transfer to Railway.** It was run with
  `docker run -v <volume>:/data`, a Docker NAMED volume, which Docker initializes from
  the image's directory ownership -- which is why a fresh one came up node-owned. Railway
  does not use named volumes. Its deploy log says
  `Mounting volume on: /var/lib/containers/railwayapp/bind-mounts/<uuid>/vol_<id>`, and a
  BIND MOUNT is not seeded from the image. Measured on 2026-09-17: a brand-new Railway
  volume, mount path `/data`, never touched by a root container, still fails as `node`
  with `EACCES ... mkdir '/data/console'`. **Every Railway volume is root-owned at
  creation.** A fresh volume fixes nothing.
- **The predicted error line was wrong for the live volume.** `openDb` calls
  `mkdir(dir, { recursive: true })`, which does NOT throw when the directory already
  exists and does not chmod it. On the S36 volume `/data/console` already existed
  root-owned, so the mkdir silently no-opped and the failure surfaced one layer down as
  `Error: PGlite failed to initialize properly` -- PGlite opening a root-owned 0700
  PGDATA as uid 1000. Anyone grepping the logs for EACCES found nothing and concluded the
  diagnosis was wrong. EACCES is what a volume WITHOUT `/data/console` gives.

**CORRECTION 2 (S61, 2026-09-17): the hand-chown candidate below is dead too, and point
3 with it.** A one-off `chown -R 1000:1000 /data` from the Railway shell was tried twice.
It reports success -- `ls -lan` really does show `1000 1000` -- and the deploy still
crash-loops, because the OLD root container keeps serving through the whole ~2 minute
build and every file it creates afterwards lands `root:root` again. The chown is stale
before the new container starts. **That race cannot be won from a shell; do not try a
third time.** The S60 attempt cost ~10 minutes of downtime, and the error it produced is
not EACCES and not the S59 string either: `RuntimeError: Aborted()` from PGlite's WASM at
`Object.callMain` -- Postgres aborting at the C layer, which reads like a corrupt build.

**The fix that ships (S61): chown from inside the container that will serve.** The console
service keeps `RAILWAY_RUN_UID=0`, so it still STARTS as root -- but the start command now
names `apps/console/server/boot.ts`, which chowns the data dir and then drops to `node`
in process before anything opens the database. At that moment the old container is gone
(Railway stops it before starting the new one when a volume is attached), so no other
writer exists and the race is removed rather than raced. `USER node` stays in the
Dockerfile as the image default, so a plain `docker run` and the engine service are
unaffected.

Three properties are deliberate:

- **It never crash-loops.** Every failure path -- no `node` in `/etc/passwd`, a chown that
  throws, a `setuid` that throws -- logs a WARNING and keeps serving as root, which is
  exactly the pre-S61 production state. Two outages bought that rule.
- **One process, no child.** Privileges are dropped with `setgroups`/`setgid`/`setuid` in
  the running process, not by spawning a server as another user, so the SIGTERM that
  drains the store still arrives directly (the whole reason the start command stopped
  going through pnpm). An ENTRYPOINT that chowns and `su-exec`s -- the usual fix -- cannot
  work here anyway: Railway execs `startCommand` as argv and it overrides `ENTRYPOINT`.
- **The import of `standalone.ts` is dynamic.** A static import would hoist above the drop
  and open PGlite as root, silently, because it would still work. `boot.test.ts` pins that
  ordering, along with the start command naming `boot.ts`.

The drop itself lives in `packages/boot` (`@reinconsole/boot`, private and unpublished)
because the hosted engine's bin needs the identical sequence -- see "Second service"
below. One copy, one test file: these invariants cost two outages and must not exist in
two places. That package's README explains the one wrinkle, which is that
`@reinconsole/store` publishes its `bin/` and so cannot import a private package by name.

**Verifying it took** (Railway deploy logs, no shell needed): the boot line
`[rein] dropped root -> node (1000:1000), N path(s) chowned in /data/console`. A WARNING
line instead means it is still root and still up -- diagnose, do not panic-deploy. From
the Railway shell, `whoami` is NOT evidence: that shell is its own root process regardless
of what the server runs as. Ask about the server process instead --
`ps -o user,pid,args -p 1` -- or check the files: `ls -lan /data/console`.

`RAILWAY_RUN_UID=0` stays set. It is no longer a tourniquet but the mechanism: it
guarantees the boot script starts with the privileges it needs to chown the volume.

One incidental finding from S59 worth keeping: the S36 volume had been pinning a STALE
seed. The boot seed runs once per data directory, so the live console had been replaying
the S36-era demo world (11 decisions / 8-3-0 / $0.07) and every seed change from S37 to
S58 was invisible in production. The current seed is 14 decisions / 10-3-1 / $0.09.
Counters alone will never reveal this -- they are self-consistent either way.

A new service with its own volume gets the same treatment rather than a clean slate: S60
established that a fresh Railway volume is root-owned too, so `rein-engine` will need its
own equivalent of `boot.ts` before it can run non-root. Whichever way this goes, check
`docker inspect --format '{{.State.ExitCode}}'` rather than merely that the container
booted.

## Shutdown

`standalone.ts` handles SIGTERM/SIGINT and drains the store before exiting, because
`world.close()` is the only thing that flushes the write-behind tail. As of S57 the three
standalone bins do the same through `installShutdown` — see "Drain on SIGTERM" below. Persist-then-
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

S61 moved the deployed entry to `boot.ts`, which drops root and then imports
`standalone.ts` in the SAME process -- no child, no second layer for a signal to
cross, so the row above still describes what is deployed.

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

## Access control (S40)

The console's mutating routes -- `POST /api/agents/:id/(freeze|unfreeze|ping)` and
`POST /api/demo/run` -- change the state of a live policy engine. As of S40 they are gated,
and the posture is decided by the environment alone (`resolveConsolePosture`, tested):

| Environment | Result |
|---|---|
| `REIN_CONSOLE_API_KEY=<secret>` | Writable; mutations need `Authorization: Bearer <secret>` |
| `REIN_CONSOLE_READONLY=1` | Read-only, whatever else is set |
| `REIN_CONSOLE_HOST=127.0.0.1` | Writable and open (local use) |
| none of the above (a public bind) | **READ-ONLY**, with a startup warning |

**What this means for the current Railway deploy:** nothing set, so the next deploy serves
the dashboard exactly as before and answers `403 read_only` to freeze/unfreeze/ping/demo.
The bind is unchanged (`0.0.0.0`), so healthchecks and the UI are unaffected. To restore the
controls, set `REIN_CONSOLE_API_KEY` -- but note the console UI has no way to send it yet
(roadmap A1b), so today that only helps a scripted caller. Read-only is the intended public
posture anyway (roadmap E2).

`GET /api/control` reports `{ writable, auth }` so a client can tell which it is talking to.

## Reconciliation tuning (S44)

The console's reconciliation panel calls an allowance a GAP once it has gone unsettled
for longer than the grace period, and re-measures on a sweep -- a gap has to age into
existence, because nothing emits when a payment fails to happen.

| Variable | Default | What it sets |
|---|---|---|
| `REIN_RECONCILE_GRACE_MS` | `60000` | How long a missing settlement is "in flight" rather than a gap |
| `REIN_RECONCILE_SWEEP_MS` | `30000` | How often the gaps are re-measured and newly-aged ones announced |

The grace default is deliberately far longer than the mock rails need (they settle in the
same tick): the number that matters is a real facilitator's, and a console that cried gap
after 200ms would be measuring its own simulator. Tighten it only against rails whose real
settlement latency you know.

## Escalations (S46)

A parked payment is one the engine refused to decide on its own authority. The console
renders these READ-ONLY on purpose: an approval is a signature over `decisionId + intentHash`
from a key the engine has registered, and a dashboard button that stood in for one would be
the click-to-approve path A2 exists to refuse.

| Variable | Default | What it sets |
|---|---|---|
| `REIN_ESCALATION_TTL_MS` | `86400000` (24h) | How long a parked payment stays answerable before it denies |
| `REIN_APPROVER_PUBLIC_KEY` | unset | An ed25519 SPKI **public** key (escaped newlines are unescaped) naming a human who can answer |
| `REIN_APPROVER_NAME` | `operator` | Display name for that key |

The TTL default is far longer than the engine's own 10 minutes because this console is an
exhibit that runs for days -- a visitor arriving eleven minutes after a deploy would find an
empty panel. The fail-closed half (expiry DENIES, on the chain) is pinned by tests and shown
in the mock demo, which is where a guarantee belongs.

Leave `REIN_APPROVER_PUBLIC_KEY` **unset on the public console** -- that is the intended
posture, not an oversight. With no approver key the panel says plainly that nothing there can
be signed and that the parked payment will expire into a denial; setting it would name a human
who is not actually on call for a demo. The console never holds a private key under any configuration, so the worst it can
do with this one is show somebody a challenge; `POST /api/escalations/:id/grant` relays a
signature made elsewhere and is gated exactly like freeze/unfreeze (so a read-only console
answers `403`).

The policy engine's standalone server has the stricter rule -- no `REIN_ENGINE_API_KEY` means
it binds loopback only, and asking for a public bind without one is a startup error. The hosted
engine (S65) runs keyed for exactly that reason.

### Answering an escalation: `scripts/approve.mjs` (S68)

The signing side of A2. Telegram shows the human the challenge; this script is where their
private key signs it, so it runs where that key lives (a laptop, an ops box) and never on
Railway. It fetches the parked request from the engine, prints the engine's OWN record of the
payment (amount, vendor, resource, reason, time left), and stops -- what a human signs must be
what they read, and the Telegram text is a copy, not the record. A second run with `--yes`
signs with the same `signApproval` the engine verifies with and submits the grant;
`--dry-run` signs without submitting, for checking a signature or carrying it by hand.

```
REIN_ENGINE_URL=https://engine.reinconsole.com
REIN_KEY_APPROVE=rk_...                       # a key with the `approve` scope (the GET needs `read`)
REIN_APPROVER_KEY_ID=apk_01J...               # the id POST /v1/approvers returned
REIN_APPROVER_PRIVATE_KEY_FILE=~/.rein/approver.pem   # or REIN_APPROVER_PRIVATE_KEY (PEM, "\n" accepted)
pnpm approve <decisionId> approve             # show and stop
pnpm approve <decisionId> approve --yes       # sign and submit
```

An already-resolved or expired request is a refused run, not a silent no-op: after expiry the
engine denies on its next sweep and a signature changes nothing, so the script says so instead
of submitting one. Register the approver's PUBLIC half with `POST /v1/approvers` under the
invitee's org; a key registered in one org cannot answer another org's escalation, and the
engine returns 404 rather than 403 for a foreign request so org ids stay unenumerable.

## Standalone service bins (S48)

Until S48 the *persistent* bins quietly opted out of that rule: `rein-engine` built its server
with no auth and bound `0.0.0.0` by default, which made the durable engine -- the one holding
the policies, the spend ledger and the signing key on disk -- the most reachable thing in the
stack. All three bins now fail closed. None of them is deployed on Railway today; each needs
its variable set BEFORE it ever is.

| Bin | Rule | To expose it |
|---|---|---|
| `rein-engine` | Inherits `authFromEnv` + `resolveHost`: no key, loopback only; public bind without a key is a startup error | `REIN_ENGINE_API_KEY=<secret>` (or `REIN_ENGINE_AUTH=off` to accept an open engine deliberately) |
| `rein-graph` | Inherits `graphAuthFromEnv` + `resolveGraphHost`: no key, loopback only; public bind without a key is a startup error. A key gates the WRITE routes (`POST /v1/events`, `/v1/reports`, `/v1/links`) with the `report` scope -- reads stay open, because a score nobody can read governs nothing | `REIN_GRAPH_API_KEY=<secret>` (comma-separated for several), or `REIN_GRAPH_PUBLIC=1` (the literal string `1`) to expose an OPEN graph deliberately, which logs a warning naming what is open |
| signer service | `buildSignerServer(signer, { adminToken })` -- the session-admin routes mint spending authority against custodied wallets, so omitting all of `adminToken`, `auth` and `adminAuth: 'off'` throws at construction | Pass an `adminToken` of at least 16 characters, and/or `auth: new ApiKeyAuth({ store })` for scoped keys (`read` to list, `admin` to mint/revoke/delete); callers send `Authorization: Bearer` or `X-Api-Key` either way. `/health` reports which is on: `off`, `bearer`, `api-key`, `bearer+api-key` |

API keys are durable wherever the PGlite store is (`api_keys`, hydrated into
`reinStore.apiKeys`). **`rein-engine` does this for you**: it opens the store
first and seeds `REIN_ENGINE_API_KEY` into it, so every key `POST /v1/keys`
mints at runtime survives a restart and every key you REVOKE stays revoked. The
env secret is re-seeded each boot without accreting a row -- it is
configuration, not state. The boot line counts what came back (`... , N api
keys`).

Compose the same thing by hand -- `new ApiKeyAuth({ store: reinStore.apiKeys })`
-- in any other deployment that issues keys at runtime, the signer's admin
surface included. With the in-memory default a key issued through the API stops
authenticating at the next restart, and -- the direction that matters -- a key
REVOKED after a leak is alive again on the next boot, because revocation is a
write too. Neither failure announces itself in a log.

`rein-graph` deliberately keeps env-seeded keys only: it has no key-issuing
route, so every key it holds comes from `REIN_GRAPH_API_KEY` and is rebuilt
identically on each boot. There is no runtime state to lose.

`rein-engine` also runs the approval tier and the dead-man monitor on the store's durable
halves, from the same variables the in-memory engine reads: `REIN_ESCALATION_TTL_MS` (default
10 minutes), and `REIN_TELEGRAM_BOT_TOKEN` + `REIN_TELEGRAM_CHAT_ID` to page a human -- both
or neither; one without the other is a startup error, because a token that quietly pages
nobody is worse than no token. (Until S53 the durable bin composed neither, so a parked
payment had nowhere to park and `/v1/approvals` answered 404 on exactly the deployment meant
to survive a restart.) To prove the Telegram leg against the real Bot API rather than a mock,
run the live-gated test with your token and chat id exported:
`RUN_LIVE=1 pnpm --filter @reinconsole/policy-engine test -- channels.live`.

The data directory is created `0700` now (POSIX only): `engine_keys.private_pem` lives in it,
and the default umask would have left it world-readable. Directories that already exist are
not re-chmodded -- tighten those by hand if an older deploy created one.

Better: keep the key out of the data directory altogether. Generate one with
`openssl genpkey -algorithm ed25519` and set it as `REIN_ENGINE_SIGNING_KEY` (the PEM; a
flattened `\n` form is accepted). `rein-engine` then signs with it and the volume holds only
the public half. On a data directory that already has a plaintext key, supply THAT key -- the
stored copy is erased on the first boot -- because a different one is refused: the resumed
chain was signed by the old key, and it cannot be continued under a new one. From then on the
variable is required; a boot without it fails rather than starting a second chain. The boot
log says which posture is live: `signing key stored` or `signing key external`.

## Rate limiting, bounded reads and lifecycle (S57)

The deployed bins get three things an embedded engine never needs. All of them are OFF for
`buildServer(engine)` with no options -- the console world, the demos and every in-process
test -- because an engine sharing a process with its only caller can only ever throttle the
application that owns it.

| Variable | Default | What it does |
|---|---|---|
| `REIN_ENGINE_RATE_LIMIT_PER_KEY` / `_PER_KEY_BURST` | 10 rps / 120 | Per authenticated API key, applied AFTER auth resolves the key id |
| `REIN_ENGINE_RATE_LIMIT_PER_IP` / `_PER_IP_BURST` | 1 rps / 30 | Per client IP, applied BEFORE auth -- `/health` included |
| `REIN_ENGINE_RATE_LIMIT=off` | on | The deliberate opt-out, mirroring `REIN_ENGINE_AUTH=off` |
| `REIN_TRUST_PROXY` | off | Which peers may name the client through `X-Forwarded-For`. `1` (or `private`) trusts a proxy reaching us from inside the network, which is every managed platform; an IP/CIDR list names one explicitly; `all` is the forgeable reading; `0`/`off` is none |
| `REIN_PRUNE_INTERVAL_MS` | 1800000 | Sweep the TTL'd burn tables this often; `0` disables |

Over the limit is `429` with `Retry-After` in seconds. A non-numeric or zero override is a
startup ERROR, not a silent fallback: somebody typing `PER_KEY=0` means "no limit", and
reading that as the default would leave them believing a limiter is off while it is fully on.

**`REIN_TRUST_PROXY=1` is required on Railway, and until S63 it was forgeable there too.**
Behind a proxy every socket address is the proxy's, so an untrusting engine rate-limits all
tenants as one client. But the variable was read as a BOOLEAN, and a boolean makes fastify
believe the LEFT-MOST `X-Forwarded-For` entry -- which is the one the client wrote, because a
proxy APPENDS the address it observed rather than erasing what arrived. So the per-IP limiter,
the only thing bounding what a caller who has proved nothing can make the engine do, could be
reset per request by rotating a header. The doc that stood here said "only set it where the
platform overwrites the header", which reads like a safe configuration exists; on Railway it
does not overwrite, and there was none.

It is now a trust SPEC naming WHICH PEERS may speak for a client, not a flag and not a hop
count. `1` resolves to the private ranges a platform's proxy lives in, so resolution walks
inward from the socket and stops at the first address that is not a trusted peer -- the one
the nearest trusted proxy actually saw. No header moves it at any depth, and a client
connecting directly is never believed at all. Four tests pin exactly that, and all four fail
when the boolean reading is put back.

**Do not "fix" this by setting a number of hops.** Express reads `2` as two hops; fastify 5
compiles any number to *trust nothing* on purpose, since a hop count cannot identify the peer
and a direct client could supply enough hops to look proxied. Measured, not read: `trustProxy:
1` and `trustProxy: 2` both leave `req.ip` as the socket address. Behind a proxy that is a
silent OFF -- one rate-limit bucket for the entire internet -- so `parseTrustProxy` refuses a
count with an error naming that consequence rather than accepting it.

(Also safe as of Sprint 1's fastify bump -- fastify < 5.12.1 had an `X-Forwarded-*` spoofing
advisory of its own, a different bug from this one.)

Bodies are capped at 64 KiB (`413`) and a request must arrive complete within 30s.

`GET /v1/decisions` is now a PAGE: 500 by default, 1000 maximum, `?after=<index>&limit=<n>`.
The body is still a bare array, so a 0.2.0 SDK parses it unchanged -- and what it gets is a
valid verifying PREFIX of the chain rather than an unverifiable slice. `Rein-Chain-Length`
gives the total; `Rein-Next-After` appears only while more remain, so its ABSENCE is how a
client knows it has reached the head. The SDK's `decisionsPage()` walks it.

The console caps concurrent SSE streams at `REIN_CONSOLE_MAX_SSE` (default 64); the 65th gets
`503` with `Retry-After`. An uncapped `/api/events` is the cheapest way to make a public
dashboard hold unbounded memory, and no credential is involved -- the feed is the read-only
half that stays open on purpose.

### Drain on SIGTERM

All three persistent bins now install `installShutdown` (`services/store/src/lifecycle.ts`):
close the server, then the store, then exit. Before S57 they simply died on redeploy and the
write-behind tail went with them -- silently, because nothing about a SIGKILLed process says a
flush was owed. A drain that wedges is abandoned after 10s and exits NON-ZERO, so a deploy
that could not flush is visible rather than indistinguishable from one that did.

Evidence to look for in the deploy log, exactly as with the console:

```
[rein] rein-engine: SIGTERM received - draining the store
[rein] rein-engine: store drained, exiting cleanly
```

The same `exec`-form start-command rule applies to every bin: **pnpm does not forward SIGTERM
to the node it spawns**, so a `pnpm --filter ... start` command makes all of this dead code.
See "Why it must not start via pnpm" above.

### One engine per data directory

PGlite admits a single writer, so this is a constraint, not a tuning knob: `numReplicas: 1`,
no overlapping deploys (the old process must exit before the new one opens the directory), and
to scale, SHARD tenants across engines with a data dir each rather than adding replicas to one.
Retention and what is never pruned: `services/store/README.md`.

### The public console: an exhibit until S67, a read-key client after it

Through S66 app.reinconsole.com was a single-world demonstration with its own embedded
mock-railed engine, and this section said it must NEVER be pointed at the hosted engine.
Sprint 5.1 reverses the CONCLUSION and keeps the REASON, so read both before changing either.

The reason was never "the console must not see real agents" -- it was that a BROWSER cannot
hold a credential the way A1b requires, so a dashboard that fetched a tenant's chain from a
public origin would be a cross-tenant leak waiting for a misconfiguration. That is still true
and nothing here weakens it. What changed is where the key lives: `remote-world.ts` polls the
engine from the console's SERVER process with an org-scoped `read` key, and the browser still
talks only to `/api/*` on its own origin. No CORS exists on the engine and none is wanted --
if the page could reach the engine directly, the key would have to reach the page.

Two things keep it from becoming authority. The read key cannot mutate anything (the engine
answers 403 on `/v1/evaluate`), and the remote world refuses every mutation BY CONSTRUCTION
before a request is even made, so the posture does not rest on `REIN_CONSOLE_READONLY=1`
staying set. The gate, signer and graph panels render empty: a policy engine has no receipts,
no session keys and no reputation evidence, and showing zeros is the honest answer.

Configure it on the console service:

- `REIN_CONSOLE_ENGINE_URL` = `https://engine.reinconsole.com`
- `REIN_CONSOLE_ENGINE_KEY` = the org-scoped **`read`** key (never the operator key)
- keep `REIN_CONSOLE_READONLY=1`
- optional: `REIN_CONSOLE_POLL_MS` (default 5000), `REIN_NETWORK_PROFILE` (a LABEL the
  console reports on `/api/status`; the policy engine is network-agnostic and publishes none)

**Setting the URL without the key is a REFUSED BOOT, deliberately.** A half-configured remote
would otherwise fall back to the seeded local demo world and serve it as production -- which
is exactly what S59 found happening, an S36 demo world being read as real.

Once it is a remote client, DELETE the console's old volume: the world it held is no longer
rendered, and a stale demo database that nothing reads is the S59 trap left lying around.

`GET /api/status` is how you check the link without log access: `{ engine, state,
publicKeyFingerprint, lastDecisionAt, lastPollAt }`. `state: "unreachable"` with the last good
data still rendered is the intended behaviour -- one failed poll is not evidence that the
engine's agents went away, and the dashboard says it is stale rather than blanking.

Tenant observability for anyone else is unchanged: the engine API with an org-scoped `read`
key, driven by whatever the tenant already uses.

## Third service: the reference vendor (S67)

`rein-vendor` at `vendor.reinconsole.com` is something for a governed agent to SPEND ON --
the other half of what the console renders. Same repo, same image, same create-a-service
procedure as the engine above, with these differences:

- Custom Start Command = `node apps/vendor/dist/index.js`
- Healthcheck Path = `/health`
- Volume mounted at `/data`, with `REIN_VENDOR_DATA_DIR=/data/vendor` (never the mount path
  itself -- see above) and `RAILWAY_RUN_UID=0` so the in-container privilege drop can run
- `REIN_VENDOR_PAY_TO` = the testnet treasury address
- `REIN_VENDOR_ORIGIN` = `https://vendor.reinconsole.com`, so quoted resources match what
  agents actually requested rather than the internal host header

**Do NOT set `REIN_VENDOR_MAINNET=1` before Sprint 8.** Without it the mainnet lane is not
constructed at all and `/v1/*` 404s, so this process cannot take a real payment even if one
is sent. Arming it additionally requires `REIN_VENDOR_MAINNET_PAY_TO` (a SEPARATE treasury).
The mainnet facilitator follows the credentials: with NO CDP keys the lane settles keyless
through PayAI (`https://facilitator.payai.network`, the Sprint 8 setup); with BOTH
`REIN_CDP_API_KEY_ID` and `REIN_CDP_API_KEY_SECRET` it settles through CDP and also advertises
the v2 header that carries the Bazaar listing. Exactly one of the two refuses to boot -- half a
pair is a typo, and guessing a facilitator for it is how money ends up somewhere unintended. The
boot log names the facilitator each lane settles through (`[vendor] mainnet settles via ...`);
read it after arming.

What it sells: `GET /testnet/v1/ping` at $0.001 -- the cheapest real payer smoke target there
is, and what an invitee's first settled payment will be -- and `GET
/testnet/v1/scores/vendor/:host` at $0.005. `GET /stats` and `GET /health` are free and
public: the console's gate panel reads `/stats`, and a dashboard that had to pay to render
itself would be absurd.

Once armed, the mainnet lane sells the same routes at the root for **$0.01** and **$0.02**
(`PRICES` in `apps/vendor/src/config.ts`). They are higher because a Base settlement is not
free: the facilitator bills the SELLER gas + 30% (PayAI: ~$0.0023 at S77), so testnet's
$0.001 would lose money on every sale. Measured over the 296 days after Base's Jovian fee floor,
a $0.01 sale ran at a loss ~0.4% of the time -- 13 congestion days, 20 minutes to 9 hours each,
peaking near $1.77 per settlement. Revisit the prices if ETH moves several-fold: the floor is
priced in ETH.

Exit check, once it is up:

```
curl -s https://vendor.reinconsole.com/health
curl -s -o /dev/null -w '%{http_code}
' https://vendor.reinconsole.com/testnet/v1/ping   # 402
curl -s -o /dev/null -w '%{http_code}
' https://vendor.reinconsole.com/v1/ping           # 404
curl -s https://vendor.reinconsole.com/stats
```

The `404` on `/v1/ping` is the load-bearing one: it proves the mainnet lane is off.

## Second service: the hosted engine (S58)

`rein-engine` runs as its OWN Railway service, from the SAME repo and the SAME
image. The console's Docker build already produces everything it needs --
`@reinconsole/console` depends on `@reinconsole/store`, so
`turbo run build --filter=@reinconsole/console` builds the store too, and
`services/store/dist/server.js` is in the image whether or not the console ever
imports it. Two services, one image, different start commands.

**Railway does NOT read `railway.engine.json`, and cannot be made to (S65).**
Config as Code is deprecated -- *"New services cannot opt into Config as Code"* --
and existing files keep working for LEGACY services only, until **2026-12-01**.
The console is such a legacy service, so `railway.json` still governs it. An
engine service created now is not, so every value below is typed into the
DASHBOARD by hand and `railway.engine.json` is the CHECKLIST it must match:
declared intent with no enforcement behind it. `deploy-config.test.ts` still
pins that file to the artifacts it names, which catches REPO-side drift -- a
moved bin, a changed health path -- but it cannot see the dashboard. Change a
start command in code and you must retype it in Railway; nothing will tell you.

Infrastructure as Code (`.railway/railway.ts`) is not an escape from this
today. Its DSL has no `watchPatterns`, and `railway config migrate` silently
drops `restartPolicy` and `builder`, so watch paths end up dashboard-managed
either way. It is also whole-project -- omitting a resource DELETES it -- so
adopting it means declaring the live console AND its volume in one apply. That
migration is its own session, before the 2026-12-01 cutoff.

| | console | engine |
|---|---|---|
| start | `node apps/console/node_modules/tsx/.../boot.ts` | `node services/store/bin/rein-engine.mjs` |
| health | `/api/health` | `/health` |
| data dir | `REIN_CONSOLE_DATA_DIR=/data/console` | `REIN_DATA_DIR=/data/engine` |
| posture | read-only exhibit | the real engine |

**The start command names the bin, not `dist/server.js`.** Both boot -- the bin
re-points `argv[1]` and imports the dist file, which only starts when it
believes it is the main module -- but the bin is the entry
`services/store/src/engine-e2e.ts` spawns, so it is the one with test evidence
behind it. It also turns a missing build into `dist/server.js not found — run
pnpm build first` instead of a module-resolution stack. `deploy-config.test.ts`
pins that agreement, along with the `railway.json` start command matching the
Dockerfile `CMD`: S36 proved that rule cannot live in prose alone.

### Human steps to create it

In Railway, a NEW service on this repo:

- Root Directory = repo root (NOT `services/store`) -- the workspace must
  install and build together, same reason as the console.
- **Config file path: expect the field to be gone, and do not go looking for
  a way to re-enable it.** New services cannot opt into Config as Code (above).
  Set these in the dashboard instead, copied from `railway.engine.json`:
  - Custom Start Command = `node services/store/bin/rein-engine.mjs`
  - Healthcheck Path = `/health`; Healthcheck Timeout = `300`
  - Restart Policy = On Failure, max retries `10`; Replicas = `1`
  - Watch Paths = `**`, `!**/*.md`, `!.github/**`, `!.claude/**`, `!scripts/**`
    -- the S59/S60 subtractive list. An EMPTY Watch Paths field is safe (every
    push rebuilds); a field scoped to one directory is the S59 bug, where a
    push silently never reaches production and nothing says so.
  - Leave Custom Build Command EMPTY -- the builder resolves the root
    `Dockerfile` on its own, and a stray value here is the S61 console trap.
  **Set the start command BEFORE the first deploy: the Dockerfile `CMD` is the
  CONSOLE.** A missing start command means Railway infers a pnpm command and
  the container never starts (S36, ~15 min of 502s); and were it ever to fall
  back to `CMD`, you would get a second console writing to the engine volume.
- Volume mounted at `/data`. **This bullet used to claim a fresh volume lands
  node-owned, so the engine would be non-root from its first deploy with no
  dashboard dance. That claim is FALSE and S59 proved it (2026-09-17.)** It
  rested on an S57 measurement taken against `docker run -v`, a Docker NAMED
  volume, which really does inherit the image's ownership of the mount point.
  Railway uses BIND MOUNTS: a brand-new Railway volume that no root container
  has ever touched still gives `EACCES ... mkdir '/data/engine'` to uid 1000.
  The console's volume history is not what makes this happen, so nothing about
  it "does not apply here" -- the engine gets the same failure on day one.
- **The code side of that is DONE as of S62, before this service exists.**
  `services/store/bin/rein-engine.mjs` now chowns `REIN_DATA_DIR` and drops to
  `node` in process before it imports `dist/server.js`, exactly as the console's
  `boot.ts` does -- the two share `@reinconsole/boot`, so there is one copy of
  the sequence and one set of tests. No Dockerfile or `railway.engine.json`
  change was needed: the start command already names the bin. **So the only
  thing left for you here is the variable below.**
- **Set `RAILWAY_RUN_UID=0` on this service.** It reads like the opposite of
  what you want and it is not: it makes the container START as root, which is
  the privilege the boot script spends on the chown before dropping. Without
  it the container starts as `node`, the drop silently no-ops (it logs
  `not-root` and does nothing), and the first boot hits the root-owned volume
  with no way out. Fail-soft means the same rollback the console has: if
  anything in the drop goes wrong the engine keeps serving AS ROOT rather than
  crash-looping, so a bad day here is a warning line, not an outage.
- Custom domain `engine.reinconsole.com`, CNAME at the DNS host.
- Enable Railway volume backups. The console's volume is disposable; this one
  holds the decision chain.

Environment:

| Variable | Value |
|---|---|
| `REIN_DATA_DIR` | `/data/engine` |
| `REIN_ENGINE_API_KEY` | bootstrap admin key; mint narrower keys via `/v1/keys` and stop using it |
| `REIN_ENGINE_SIGNING_KEY` | a FRESH `openssl genpkey -algorithm ed25519` PEM |
| `REIN_TELEGRAM_BOT_TOKEN` + `REIN_TELEGRAM_CHAT_ID` | both or neither |
| `REIN_ESCALATION_TTL_MS` | `3600000` |
| `REIN_TRUST_PROXY` | `1` -- per-IP rate limits are meaningless behind a proxy without it, and forgeable if you write anything else. Not a hop count: see "Rate limiting" above |
| `RAILWAY_RUN_UID` | `0` -- start as root so the boot script can chown the volume, then drop. See the bullet above; without it the drop no-ops |
| `HOST` | unset. A keyed engine binds `0.0.0.0` on its own; setting it is how you bind a public interface by accident |

Generate the signing key BEFORE the first boot. A fresh service has no chain
to continue, so there is no key migration -- but once the first decision is
signed, "once external, always external" applies: the variable is required
from then on and a boot without it fails rather than starting a second chain.

### Exit checks

First look in the deploy log for the drop, which is the one thing no HTTP
check can see:

```
[rein] dropped root -> node (1000:1000), N path(s) chowned in /data/engine
```

A WARNING line there instead means the engine is up and still root -- diagnose
it, do not panic-deploy. `whoami` in the Railway shell is NOT evidence: that
shell is its own root process whatever the server runs as. Ask about the server
or look at the files (`ls -lan /data/engine`, which must read `1000 1000`).

**`ps` is not installed in `node:22-slim`,** so the obvious question about pid 1
answers `executable file not found` and reads like a broken container. Use
procfs instead -- and read all four Uid fields, because the saved uid is what
says root is unrecoverable rather than merely set aside:

```
cat /proc/1/status | grep -E '^(Name|Uid|Gid):'
# Name: node
# Uid:  1000  1000  1000  1000
```

### Rehearsed locally before the service existed (S63)

The whole env block below was booted in the real image on a root-owned volume
before any of it was typed into Railway -- the S37/S57 rule applied to a
configuration rather than a Dockerfile. What it proved, in order: the drop line
with 2 paths chowned on a fresh `/data/engine`; a bind on `0.0.0.0` with
`auth: api-key` from `HOST` being unset; `fresh store; signing key external`,
which is the external-key path working from a PEM flattened to literal `\n`
(`parseSigningKey` accepts both forms, so Railway's multiline field and a
flattened one are equivalent); `/health` 200 while `/v1/agents` is 401 unkeyed
and 200 keyed; pid 1 as `node` with all four Uid fields 1000; `/data/engine`
turned `0:0` -> `1000:1000`; a SIGTERM draining to exit 0; a second container on
the same volume resuming its api keys with an IDENTICAL publicKey fingerprint;
and a boot with `REIN_ENGINE_SIGNING_KEY` removed REFUSING to start
(`this data directory's engine signing key is held externally`, exit 1) rather
than minting a second chain. That last one is the failure mode to recognize at
3am: it is a deleted variable, not a corrupt volume.

```
curl https://engine.reinconsole.com/health
REIN_E2E_ENGINE_URL=https://engine.reinconsole.com REIN_ENGINE_API_KEY=... RUN_LIVE=1 \
  pnpm --filter @reinconsole/store exec vitest run src/engine.e2e.live.test.ts
```

Then the publicKey fingerprint recipe below, across a redeploy. The restart and
drain cases in the e2e self-skip against a remote engine: they need a process
to signal, and a hosted one is not ours to kill.

## The live workflow (S58)

`.github/workflows/live.yml` runs the suites that spend real testnet money and
talk to real third parties -- daily, and on `workflow_dispatch` with a `suite`
input. `ci.yml` pins `RUN_LIVE` empty on purpose: settling payments is not
something a push should decide to do, and a fork's pull request must never
reach these secrets.

`concurrency: live` with `cancel-in-progress: false` is load-bearing in both
halves. The suites share ONE funded Sepolia wallet, so two runs race on its
nonce and balance -- and cancelling a run mid-settlement abandons a payment
that is already on-chain, which is worse than waiting.

Each suite is `continue-on-error` with a summary step that fails the run: "the
facilitator is down" must not hide "Telegram is also down". A failure pages the
same Telegram chat a production escalation would, which doubles as a standing
check that the channel still works.

`.github/scripts/live-preflight.mjs` runs first and fails in seconds with
`fund the wallet` rather than twenty minutes later with a facilitator error
meaning the same thing. Repository secrets: `REIN_SEPOLIA_PRIVATE_KEY`,
`REIN_SEPOLIA_VENDOR_ADDRESS`, `REIN_SEPOLIA_RPC_URL` (keyed -- the public RPC
rate-limits), `REIN_SEPOLIA_ERC8004_ID`, the Telegram pair, and once the engine
is up `REIN_E2E_ENGINE_URL` + `REIN_ENGINE_API_KEY`.

### The vendor leg pays for itself once a week (S71)

The sixth leg runs `scripts/pilot-checks.mjs` against the whole live estate at
once -- `vendor.reinconsole.com` quoting, `engine.reinconsole.com` deciding,
Base Sepolia settling -- which is the only check that covers the seam between
them rather than any one service. It is also the only leg that spends money on
purpose, so the mode is chosen rather than fixed:

- **Advisory every night** (`--advisory`), and it is FREE. No payer key is
  constructed at all, so the run proves the service is up, the cert is valid,
  the 402 quotes correctly, the engine decides, and the pilot agent and policy
  are intact -- everything that realistically breaks.
- **Full once a week** (`--all`, Mondays by `date -u +%u`), at about $0.046.
  This is what catches the facilitator or the chain being down, which advisory
  cannot: roughly $2.40 a year against $17 for running it nightly.
- `workflow_dispatch` with `spend: true` forces the full run on any day.

Secrets: `REIN_PILOT_AGENT_ID` and `REIN_PILOT_AGENT_KEY` (a key narrowed to
that one agent, scopes `evaluate`+`read`). The payer falls back to
`REIN_SEPOLIA_PRIVATE_KEY`, the wallet the other spending suites already use --
nothing in the engine binds a payer to an agent's registered `wallets`, which
is descriptive metadata and not enforcement. Set
`REIN_PILOT_PAYER_PRIVATE_KEY` only to pay from the pilot's own wallet.

**Two deliberate shapes here.** The mode step emits an EMPTY `arg` when the
pilot secrets are unset, so the leg genuinely skips instead of exiting 0 -- an
unconfigured check reading green is the S69 outage in miniature, where a
passing healthcheck meant nothing had been checked. And each advisory run
leaves a permanent `unsettled` row in `/v1/reconciliation`: a decision the
policy allowed and nothing ever paid is exactly what advisory mode IS, so the
gap is correct and must not be "fixed". Within the report's 24h window there
should be about one of them, which makes it a liveness signal in its own right.

**The advisory check cannot assert `allow`, and the first version did.** Its
very first CI run failed: the $0.04 hourly cap had already been spent, so the
engine denied a $0.001 ping. That is not a fault -- a `deny` from the rolling
budget proves the vendor is up, the cert is valid, the 402 quotes correctly,
the engine reached a signed decision and the agent and policy still exist,
which is everything this check exists to prove. It now passes on either a
`402` released unpaid OR a deny whose reason names `hour-budget`, and the
tolerance is deliberately that narrow: any other denial -- a frozen agent, a
vanished policy, a `tx-cap` that should not match $0.001 -- is a real failure
and stays one.

What makes this unavoidable rather than bad luck: **`rollingSum` counts
ALLOWED decisions, settled or not, so the free advisory check moves the budget
it is measured against.** Four unpaid pings in an hour will tip a cap that
$0.005 calls left room under, because the rule compares the sum PLUS this
amount -- which is also why a $0.001 ping can slip under a ceiling that
refuses a $0.005 one. Check 3 spends the cap on purpose, so every Monday run
leaves roughly an hour in which the old assertion would have failed, and any
manual run does the same.

## Network profiles (S58)

`REIN_NETWORK_PROFILE` is `testnet` (the default) or `mainnet`, and an unknown
value is a startup error rather than a fallback: an operator who typed `mainet`
meant mainnet, and a vendor quietly taking real requests while being paid in
play money looks exactly like everything working.

It resolves a `NetworkProfile` (`services/x402-rails/src/profiles.ts`) carrying
the chain id, USDC address, facilitator URL and EIP-712 domain for that network.
Libraries never read the variable -- composing apps read it and pass the profile
down, so two profiles can coexist in one process.

**Two things about it are safety rails, not configuration.**

The guard and the payer both take a `networks` allow-list, and both need it.
The policy engine CANNOT enforce this boundary: `networkToChain` folds
`base-sepolia` into `base` because policy is written about chains, not
deployments, so by the time an intent reaches `/v1/evaluate` a testnet and a
mainnet payment are indistinguishable and any policy allowing one allows the
other. The offer comes from the vendor, so without an allow-list the VENDOR
chooses which chain the agent's key spends on.

The EIP-712 domain differs between the two networks -- Base Sepolia's USDC is
named `USDC`, Base mainnet's is `USD Coin` -- and `payer.ts` used to hardcode
the Sepolia spelling as its fallback. That signs a well-formed authorization
the mainnet contract rejects at settlement: a failure that appears only with
real money on the line. `profiles.live.test.ts` reads the name, version and
decimals off the real contract (`RUN_LIVE_MAINNET=1`, read-only, no key) rather
than letting a unit test agree with itself.

## Verifying a deploy

```
curl -s https://app.reinconsole.com/api/state | jq '.stats'
```

`decisions` and `chainLinks` come from the same signed chain and cannot drift. If
they disagree, something is wrong with the store, not the projection.

### Proving persistence without log access

The counters CANNOT prove it. The boot seed is deterministic, so a world that
reseeded from scratch reports exactly the same 14 decisions / 10-3-1 / $0.09 / 10
subjects as one that resumed. Two deploys in a row showing identical numbers is
not evidence of anything. (Those are the CURRENT seed's numbers, measured
2026-09-17. This paragraph used to quote 11 / 8-3-0 / $0.07 / 9, which was the
S36 seed that production had been silently replaying off a stale volume until
S59 deleted it -- so the numbers a reader compared against were themselves the
artefact being looked for.)

The boot line does distinguish the two: `resumed 14 decisions, ...` versus
`fresh store (seeded)`. What it does NOT prove is that the signing key came back
with the world, which is what the fingerprint below is for.

The engine's ed25519 signing key is the honest signal: it is generated once and
persisted (`engine_keys`), so it is STABLE across restarts when the volume works
and REGENERATED every boot when it does not.

```
curl -s https://app.reinconsole.com/api/state \
  | jq -r .publicKey | tr -d '\r' | sha256sum | cut -c1-16
```

`5f7279d44ba533bc` as of 2026-09-17. Record it, redeploy, run it again. Same
fingerprint means the store really resumed; a different one means the service is
writing to disposable disk no matter what the counters say.

**The `tr -d` is load-bearing, and it was missing until 2026-09-17.** The recipe
hashes a PEM, so it hashes LINE ENDINGS: git-bash's `jq` on Windows writes CRLF,
GNU `jq` on Linux writes LF, and the same key therefore fingerprints as
`61a02be55f0e1f22` on one box and `5f7279d44ba533bc` on the other. That cost a
session's worth of doubt once -- the mismatch was read as evidence that the
volume was disposable, when the key had never changed at all. Stripping CR makes
the value comparable across machines.

The hosted engine's equivalent is its own unauthenticated `/health`, which
carries the same `publicKey`:

```
curl -s https://engine.reinconsole.com/health | jq -r .publicKey | tr -d '\r' | sha256sum | cut -c1-16
```

**`jq -r` appends a newline to a PEM that already ends in one, so this value is
NOT the sha256 of the key file (S63).** The recipe is self-consistent -- every
deploy is measured the same way, so the across-a-redeploy comparison it exists
for is sound -- but comparing it against a fingerprint taken from
`engine-signing-key.pem` produces a mismatch out of two files that hold the same
key. That is the S60 scar in a second costume: there the phantom difference was
CRLF, here it is one trailing byte, and both times the honest reading of a
mismatch ("the volume is disposable") is the expensive one. To derive the
expected value from the private key BEFORE the first boot -- the check that says
the engine came up on the key you generated rather than one it minted -- add the
newline back:

```
{ node -e "const{createPublicKey}=require('crypto'),fs=require('fs');\
process.stdout.write(createPublicKey(fs.readFileSync('engine-signing-key.pem'))\
.export({type:'spki',format:'pem'}).toString())"; echo; } \
  | tr -d '\r' | sha256sum | cut -c1-16
```

Note also what the fingerprint can and cannot tell you, because the STRUCTURE is
the stronger guarantee. `loadOrCreateKeyPair` in `services/store/src/keys.ts`
generates a key only when `engine_keys` has NO row -- and a data dir with no key
row has no decisions to resume either. A row with a private key is returned as
is; a row whose private half was erased refuses to boot without the external key
rather than minting a new one. So "resumed N decisions" and "regenerated the
key" are mutually exclusive by construction: a boot line saying `resumed`
already proves the chain is still verifiable under the published key. The
fingerprint is a second, independent witness -- useful, but it is not the thing
holding the guarantee up.

