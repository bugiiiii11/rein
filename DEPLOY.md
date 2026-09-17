# Deploying the Rein Console

The console (`apps/console`) is the only deployed service. It runs on Railway from
the repo-root `Dockerfile`, serving the built Vite UI plus the console API and SSE
stream from one Node process (`apps/console/server/standalone.ts`).

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
   updated with the settings defined in code". So the console service's Settings ->
   Build panel will KEEP displaying the old `apps/console/**` after this ships. That
   is documented behaviour, not a failure. Clearing the dashboard field anyway is
   worth doing so the next person to read it is not misled, but it is cosmetic.
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

Current state: `RAILWAY_RUN_UID=0` is set on the console service as a tourniquet, so the
container runs as root despite `USER node`, the volume works, and the site is up. The
non-root goal is NOT achieved and needs a real solution -- the candidate is a one-off
`chown -R 1000:1000 /data` from a root shell (which `RAILWAY_RUN_UID=0` provides without
touching `startCommand`), after which the variable can be removed; unverified as of S59.

One incidental finding worth keeping: the S36 volume had been pinning a STALE seed. The
boot seed runs once per data directory, so the live console had been replaying the
S36-era demo world (11 decisions / 8-3-0 / $0.07) and every seed change from S37 to S58
was invisible in production. The current seed is 14 decisions / 10-3-1 / $0.09. Counters
alone will never reveal this -- they are self-consistent either way.

**3. The container runs as the unprivileged `node` user, and turning that on needs a fresh
volume under it (S57 measured, S58 enabled).** Both cases were run against this image on
2026-09-16 with `docker run -v <volume>:/data -e REIN_CONSOLE_DATA_DIR=/data/console`:

| Volume | Result |
|---|---|
| Fresh, with the image's node-owned `/data` | Boots, seeds, `drwx------ node node`, SIGTERM drains, exit 0 |
| Already exists root-owned (what Railway had) | `EACCES: permission denied, mkdir '/data/console'`, exit 1 |

app.reinconsole.com's volume was created in S36 by a root container, and Docker does not
re-initialize an existing volume from the image. **Founder call 2026-09-17: recreate the
volume.** The console is a read-only demo exhibit — it reseeds deterministically and the
deploy log says `fresh store (seeded)` — it is the only option that actually leaves the
container unprivileged, and destroying the disk is also the only complete erasure of the
plaintext signing key, which S57 proved survives an `UPDATE` in both the heap and the WAL.
The alternatives considered and declined: chowning the mount to uid 1000 needs a one-off
root run, which on Railway means temporarily editing the `startCommand` that caused the S36
outage, and keeps that plaintext key on disk; `RAILWAY_RUN_UID=0` declines the change
explicitly but closes nothing.

**Do the two steps in this order, and in one sitting.** Recreate-then-push is the wrong
order and lands you back on the same EACCES with a brand-new volume: a fresh volume lands
node-owned, but a still-root container booting onto it FIRST creates `/data/console` as
`root:root 0700`, and the node image cannot enter it. The first process to touch the fresh
volume must be the node one.

1. Push the image with `USER node`. The deploy crash-loops with the measured EACCES on the
   old volume — expected, and it is `ON_FAILURE` with `restartPolicyMaxRetries: 10`.
2. Delete and recreate the volume in the Railway dashboard. The restart boots as `node`
   onto a node-owned volume and seeds.
3. Confirm exit code 0 and `fresh store (seeded)`, then re-record the signing-key
   fingerprint (see "Proving persistence without log access") — the old one is gone with
   the volume, and the new value is the baseline from here on.

The window between 1 and 2 is real downtime on a public page, which is why they belong
together rather than across sessions.

The usual fix — an ENTRYPOINT that chowns and then drops privileges — does NOT apply here:
Railway execs `startCommand` as argv and it overrides `ENTRYPOINT` (see point 1 above).

A new service with its own FRESH volume has none of this history, so `rein-engine` is
non-root from its first deploy in Sprint 4 with no dashboard step at all. Whichever way this
goes, check `docker inspect --format '{{.State.ExitCode}}'` rather than merely that the
container booted.

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
it binds loopback only, and asking for a public bind without one is a startup error. It is not
deployed on Railway today; if it ever is, it needs the key first.

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
| `REIN_TRUST_PROXY=1` | off | Read the client IP from `X-Forwarded-For` |
| `REIN_PRUNE_INTERVAL_MS` | 1800000 | Sweep the TTL'd burn tables this often; `0` disables |

Over the limit is `429` with `Retry-After` in seconds. A non-numeric or zero override is a
startup ERROR, not a silent fallback: somebody typing `PER_KEY=0` means "no limit", and
reading that as the default would leave them believing a limiter is off while it is fully on.

**`REIN_TRUST_PROXY=1` is required on Railway and dangerous anywhere else.** Behind a proxy
every socket address is the proxy's, so an untrusting engine rate-limits all tenants as one
client. In FRONT of one, a header nobody strips is a header anybody can forge, which turns the
per-IP limiter into a no-op. Only set it where the platform actually overwrites the header.
(Safe as of Sprint 1's fastify bump -- fastify < 5.12.1 had an `X-Forwarded-*` spoofing
advisory of its own.)

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

### The public console is an exhibit, not a tenant dashboard

app.reinconsole.com is a single-world demonstration with its own embedded mock-railed engine,
and it must NEVER be pointed at the hosted engine with authority over real agents. There is no
console read key and there is not going to be one: a browser cannot hold a credential the way
A1b requires, and a dashboard that could read one tenant's chain from a public origin is a
cross-tenant leak waiting for a misconfiguration. Tenant observability is the engine API with
an org-scoped `read` key, driven by whatever the tenant already uses.

## Second service: the hosted engine (S58)

`rein-engine` runs as its OWN Railway service, from the SAME repo and the SAME
image. The console's Docker build already produces everything it needs --
`@reinconsole/console` depends on `@reinconsole/store`, so
`turbo run build --filter=@reinconsole/console` builds the store too, and
`services/store/dist/server.js` is in the image whether or not the console ever
imports it. Two services, one image, different start commands.

Config lives in `railway.engine.json`, selected per service with Railway's
config-file path setting. `railway.json` continues to belong to the console.

| | console | engine |
|---|---|---|
| start | `node apps/console/node_modules/tsx/.../standalone.ts` | `node services/store/bin/rein-engine.mjs` |
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
- Config file path = `railway.engine.json`.
- Volume mounted at `/data`. **This bullet used to claim a fresh volume lands
  node-owned, so the engine would be non-root from its first deploy with no
  dashboard dance. That claim is FALSE and S59 proved it (2026-09-17.)** It
  rested on an S57 measurement taken against `docker run -v`, a Docker NAMED
  volume, which really does inherit the image's ownership of the mount point.
  Railway uses BIND MOUNTS: a brand-new Railway volume that no root container
  has ever touched still gives `EACCES ... mkdir '/data/engine'` to uid 1000.
  The console's volume history is not what makes this happen, so nothing about
  it "does not apply here" -- the engine gets the same failure on day one.
  There is no verified non-root recipe for a Railway volume yet; the console is
  where it is being worked out (handoff row 1), so settle it there FIRST and
  create this service with whatever that establishes. The interim is the
  console's: set `RAILWAY_RUN_UID=0` on the service, which runs the container
  as root and is also the rollback for anything else attempted.
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
| `REIN_TRUST_PROXY` | `1` -- per-IP rate limits are meaningless behind a proxy without it |
| `HOST` | unset. A keyed engine binds `0.0.0.0` on its own; setting it is how you bind a public interface by accident |

Generate the signing key BEFORE the first boot. A fresh service has no chain
to continue, so there is no key migration -- but once the first decision is
signed, "once external, always external" applies: the variable is required
from then on and a boot without it fails rather than starting a second chain.

### Exit checks

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

