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
# THE ORDER IS THE TRAP, and recreate-then-push is the WRONG one. A fresh volume lands
# node-owned (the mkdir above), but a still-root container booting onto it FIRST creates
# /data/console as root:root 0700, and the node image then hits the SAME EACCES on a
# brand-new volume. The first process to touch a fresh volume must be the node one: ship
# this line, let the deploy crash-loop on the old volume, THEN recreate it in the Railway
# dashboard, and the restart seeds as node. That gap is real downtime on a public page, so
# both steps belong in one sitting.
#
# Note also that an ENTRYPOINT that chowns and then drops privileges -- the usual fix --
# does NOT work here: Railway execs `startCommand` as argv and it overrides ENTRYPOINT.
USER node

# pnpm 10 skips dependency build scripts by default; esbuild (used by vite + tsup) needs its
# native binary built or the build crashes — the same gotcha as local dev, so rebuild it here.
RUN pnpm install --frozen-lockfile \
 && pnpm rebuild esbuild \
 && pnpm exec turbo run build --filter=@reinconsole/console

# Must stay AFTER the install above: set earlier, pnpm skips devDependencies and tsx —
# which the start command runs — is not in the image.
ENV NODE_ENV=production

# Liveness only, and deliberately against /api/health rather than /api/state: the probe
# used to serialize the whole world every few seconds, which made a full state dump the
# cheapest request on the box. Railway runs its own healthcheck from railway.json; this
# one is for `docker run` and any other runtime that reads the image's own declaration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# standalone.ts serves apps/console/dist + the console API/SSE on $PORT (Railway injects PORT).
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
CMD ["node", "apps/console/node_modules/tsx/dist/cli.mjs", "apps/console/server/standalone.ts"]
