# syntax=docker/dockerfile:1
# Railway build for @rein/console — the full-stack console (Vite UI + Node API + SSE + world).
# Built from the repo ROOT on purpose: @rein/console depends on 10 workspace packages, so the
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
 && pnpm exec turbo run build --filter=@rein/console

ENV NODE_ENV=production
# standalone.ts serves apps/console/dist + the console API/SSE on $PORT (Railway injects PORT).
CMD ["pnpm", "--filter", "@rein/console", "start"]
