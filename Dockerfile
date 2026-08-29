# syntax=docker/dockerfile:1
# Railway build for @reinconsole/console — the full-stack console (Vite UI + Node API + SSE + world).
# Built from the repo ROOT on purpose: @reinconsole/console depends on 10 workspace packages, so the
# whole pnpm/Turborepo workspace must be installed and built together. (Set the Railway service's
# Root Directory to the repo root — NOT apps/console — or the workspace deps won't resolve.)
FROM node:22-slim
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app

# Copy the whole monorepo (see .dockerignore for exclusions) and install from the lockfile.
COPY . .
# pnpm 10 skips dependency build scripts by default; esbuild (used by vite + tsup) needs its
# native binary built or the build crashes — the same gotcha as local dev, so rebuild it here.
RUN pnpm install --frozen-lockfile \
 && pnpm rebuild esbuild \
 && pnpm exec turbo run build --filter=@reinconsole/console

# Must stay AFTER the install above: set earlier, pnpm skips devDependencies and tsx —
# which the start command runs — is not in the image.
ENV NODE_ENV=production

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
