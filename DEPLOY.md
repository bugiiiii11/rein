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

