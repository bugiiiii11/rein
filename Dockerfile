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

# NOTE: this must stay AFTER the install above. Setting it earlier makes pnpm skip
# devDependencies, and tsx — which the start command below runs — is one of them.
ENV NODE_ENV=production

# standalone.ts serves apps/console/dist + the console API/SSE on $PORT (Railway injects PORT).
#
# Exec form, invoking node DIRECTLY rather than `pnpm ... start`, so node is PID 1.
# Under a package-manager wrapper node runs as a CHILD, and the wrapper does not
# reliably forward SIGTERM: the graceful drain in standalone.ts never runs, the
# runtime SIGKILLs after the grace period, and the container exits non-zero (which
# a platform reports as "crashed" on every ordinary redeploy). Signals must reach
# node itself or the write-behind tail is never flushed.
#
# Keep railway.json free of a `startCommand` — it would override this and reintroduce
# a shell in front of node.
CMD ["node", "apps/console/node_modules/tsx/dist/cli.mjs", "apps/console/server/standalone.ts"]
