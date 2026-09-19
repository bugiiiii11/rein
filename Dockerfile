# syntax=docker/dockerfile:1
# Railway build for @reinconsole/console — the full-stack console (Vite UI + Node API + SSE + world).
# Built from the repo ROOT on purpose: @reinconsole/console depends on 10 workspace packages, so the
# whole pnpm/Turborepo workspace must be installed and built together. (Set the Railway service's
# Root Directory to the repo root — NOT apps/console — or the workspace deps won't resolve.)
FROM node:22-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Everything the unprivileged `node` user needs is prepared here, and the switch itself is
# the `USER node` below -- off through S57 while it was measured, ON as of 2026-09-17.
#
# /app is chowned so a non-root build can write node_modules, dist and .turbo. /data is
# created and given to node because Docker (and Railway) initialize a FRESH volume with the
# ownership of the directory it is mounted over: without this the mount lands root-owned.
RUN chown -R node:node /app && mkdir -p /data && chown -R node:node /data

# Copy the whole monorepo (see .dockerignore for exclusions) and install from the lockfile.
COPY --chown=node:node . .

# Measured in this image, 2026-09-16, both against `docker run -v <volume>:/data` with
# REIN_CONSOLE_DATA_DIR=/data/console:
#
#   fresh volume, with the mkdir above      -> boots, seeds, `drwx------ node node`,
#                                              SIGTERM drains, exit 0
#   volume that ALREADY EXISTS root-owned   -> EACCES: permission denied, mkdir
#                                              '/data/console' -> exit 1
#
# app.reinconsole.com's volume was created in S36 by a root container, and an existing
# volume is NOT re-initialized from the image, so this line needs a FRESH volume under it.
# Founder call 2026-09-17: recreate the volume. The console is a read-only demo exhibit --
# it reseeds deterministically, and destroying the disk is also the only complete erasure
# of the plaintext signing key S57 found surviving in the heap and the WAL.
#
# CORRECTION (2026-09-17, S61): the mkdir above does NOT make this safe on Railway, and
# the recreate-the-volume plan below it is dead. A fresh Railway volume lands ROOT-owned
# regardless -- S60 proved it -- and worse, the OLD root container keeps serving through
# the whole ~2 minute build, so anything it writes after a manual chown is root-owned
# again. Two hand-chown attempts failed (S59, S60); the second took the site down ~10 min.
# The failure is not even EACCES at that point: PGlite aborts inside its WASM Postgres
# (`RuntimeError: Aborted()`).
#
# So this line is now the image's DEFAULT, not the deployment's mechanism. The console
# service runs with RAILWAY_RUN_UID=0, starts as root, and drops to node itself in
# apps/console/server/boot.ts -- after chowning the volume, inside the container that will
# serve it, at the one moment no other writer exists. See packages/boot/src/privileges.ts
# (shared with the engine bin, which does the same thing) for the full why,
# including why an ENTRYPOINT that chowns and drops cannot work here: Railway execs
# `startCommand` as argv and it overrides ENTRYPOINT.
#
# Keeping USER node means a plain `docker run` of this image is still unprivileged.
# The engine service builds from this same image and takes the same route as of S62:
# RAILWAY_RUN_UID=0, and services/store/bin/rein-engine.mjs chowns /data/engine and drops
# before it imports dist/server.js. Both entries share packages/boot.
USER node

# pnpm 10 skips dependency build scripts by default; esbuild (used by vite + tsup) needs its
# native binary built or the build crashes — the same gotcha as local dev, so rebuild it here.
RUN pnpm install --frozen-lockfile \
 && pnpm rebuild esbuild \
 && pnpm exec turbo run build --filter=@reinconsole/console --filter=@reinconsole/vendor

# One image, three services (console, engine, vendor), so every service's start
# command must find its entry HERE. The engine needs no filter of its own --
# @reinconsole/console depends on @reinconsole/store, so turbo builds it anyway
# -- but the vendor is nothing's dependency, and without its own filter
# apps/vendor/dist/index.js simply would not exist. The failure would surface
# only on the vendor service, at boot, after a green build. deploy-config.test.ts
# pins this against every railway*.json start command.

# Must stay AFTER the install above: set earlier, pnpm skips devDependencies and tsx —
# which the start command runs — is not in the image.
ENV NODE_ENV=production

# Liveness only, and deliberately against /api/health rather than /api/state: the probe
# used to serialize the whole world every few seconds, which made a full state dump the
# cheapest request on the box. Railway runs its own healthcheck from railway.json; this
# one is for `docker run` and any other runtime that reads the image's own declaration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# boot.ts drops root (see above) and then imports standalone.ts, which serves
# apps/console/dist + the console API/SSE on $PORT (Railway injects PORT).
#
# Invokes node directly instead of `pnpm --filter ... start`. That is the whole shutdown
# fix: pnpm does not forward SIGTERM to the node it spawns, so the graceful drain in
# standalone.ts never ran, however correct its code was. Verified in this image — the
# pnpm form is SIGKILLed (exit 137, no drain lines), this form exits 0 after draining.
#
# Keep it in exec (JSON) form and do NOT prefix it with `exec`. Railway runs a start
# command as argv, not through a shell, so a leading `exec` is looked up as a BINARY and
# the container never starts — an outage, versus a lost flush.
#
# railway.json MUST keep an equivalent `startCommand`. Removing it does NOT fall back to
# this CMD — Railway substituted its own inferred pnpm command, which is what took the
# site down for ~15 min in S36 (`No projects matched the filters in "/app"`).
CMD ["node", "apps/console/node_modules/tsx/dist/cli.mjs", "apps/console/server/boot.ts"]
