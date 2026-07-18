# Production Dockerfile for Lion Reader
# Multi-stage build for optimal image size

# CDN base URL for the hashed /_next/static assets. Unset by default (bare
# `docker build` → origin-served); production supplies it via fly.toml. Declared
# globally and re-declared per stage so the Next build and the runtime always
# agree on the value. See next.config.ts for what it does.
ARG ASSET_PREFIX

# =============================================================================
# Stage 1: Base image with pnpm (for building)
# =============================================================================
FROM node:26-alpine AS base

# Install the exact pnpm version from package.json
# (Node 26 no longer bundles corepack, so install pnpm directly via npm)
RUN npm install -g pnpm@10.26.2

# Set working directory
WORKDIR /app

# =============================================================================
# Stage 2: Install dependencies
# =============================================================================
FROM base AS deps

# Copy package files
# pnpm-workspace.yaml holds our dependency overrides (security pins) and build
# settings, so pnpm must see it here for --frozen-lockfile to resolve correctly.
# native/* are workspace packages, so their manifests must be present too.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY native/sanitizer/package.json ./native/sanitizer/package.json
COPY native/readability/package.json ./native/readability/package.json
COPY native/feed-parser/package.json ./native/feed-parser/package.json

# Install all dependencies (including devDependencies for building)
# Use --ignore-scripts because postinstall needs files not yet copied
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# =============================================================================
# Stage 3: Build the native (Rust) modules for this image's platform (musl)
# =============================================================================
# A separate stage keyed only on native/ sources: pure-TS deploys hit the layer
# cache and skip the Rust toolchain install and cargo build entirely, and when
# Rust does change, BuildKit runs this stage in parallel with the JS build.
# The build.mjs scripts are plain `node` + `cargo` — no pnpm/node_modules needed.
# Cache mounts keep crate downloads and incremental build artifacts across
# builds (each build.mjs copies its artifact out of target/ to <name>.node).
FROM node:26-alpine AS native-builder

WORKDIR /app

RUN apk add --no-cache rust cargo

# .dockerignore excludes native/*/target/ and native/*/*.node so local build
# artifacts can't leak into (or bust the cache of) this layer.
COPY native ./native

RUN --mount=type=cache,id=cargo-registry,target=/root/.cargo/registry \
    --mount=type=cache,id=cargo-target,target=/app/native/sanitizer/target \
    --mount=type=cache,id=cargo-target-readability,target=/app/native/readability/target \
    --mount=type=cache,id=cargo-target-feed-parser,target=/app/native/feed-parser/target \
    node native/sanitizer/build.mjs && \
    node native/readability/build.mjs && \
    node native/feed-parser/build.mjs

# =============================================================================
# Stage 4: Build the application
# =============================================================================
FROM base AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Steps that depend ONLY on node_modules / the native-builder stage go ABOVE
# `COPY . .` so a source-only change (the common deploy) leaves them cached and
# jumps straight to `pnpm build`. public/onnx/ and native/*/*.node are in
# .dockerignore, so the `COPY . .` overlay below won't clobber what we generate.

# Copy ONNX WASM files to public/ (reads node_modules only). Copy just the
# script first so this layer busts only when the script itself changes.
COPY scripts/copy-onnx-wasm.mjs ./scripts/copy-onnx-wasm.mjs
RUN node scripts/copy-onnx-wasm.mjs

# Compiled native modules (the runner also copies these out of this stage)
COPY --from=native-builder /app/native/sanitizer/sanitizer.node ./native/sanitizer/sanitizer.node
COPY --from=native-builder /app/native/readability/readability.node ./native/readability/readability.node
COPY --from=native-builder /app/native/feed-parser/feed-parser.node ./native/feed-parser/feed-parser.node

# Copy source code
COPY . .

# Set environment for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production

# NOTE: GIT_COMMIT_SHA (surfaced in the outgoing User-Agent) is deliberately
# NOT a build arg — it's a runtime env var set by CI at deploy time
# (fly deploy --env GIT_COMMIT_SHA=..., see .github/workflows/deploy.yml).
# Keeping the SHA out of the build keeps these layers cacheable across deploys.
# Dummy URLs for build - modules check these exist but don't connect
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV REDIS_URL="redis://localhost:6379"

# CDN base URL for /_next/static (see the global ARG at the top of this file).
# Demo hero/OG images are imported into the Next build too, so they're hashed
# into /_next/static/media and served from this same CDN origin automatically.
ARG ASSET_PREFIX
ENV ASSET_PREFIX=$ASSET_PREFIX

# Client-side Sentry DSN. NEXT_PUBLIC_* vars are inlined into the client
# bundle at build time, so a runtime secret is not enough — the DSN must be
# provided to the build (fly.toml [build.args]). DSNs are not secret (they
# ship in the client bundle by design). Empty means client Sentry is disabled.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

# Deploy timestamp, inlined into the client bundle so the demo's "Welcome"
# article shows a stable published time that matches the server render (see
# src/app/demo/articles/welcome-published-at.ts). CI passes the same value as a
# runtime --env too, so the server reads an identical value; unset builds fall
# back to a fixed date. Placed last among the NEXT_PUBLIC args so its per-deploy
# churn only busts the build layer (which re-runs each deploy anyway).
ARG NEXT_PUBLIC_BUILD_TIME=""
ENV NEXT_PUBLIC_BUILD_TIME=$NEXT_PUBLIC_BUILD_TIME

# Build Next.js application. The cache mount persists .next/cache (webpack's
# persistent build cache) across builds, cutting warm build times — and keeps
# it out of the image layers (it's build-time-only; the runtime recreates the
# dir if it needs it).
RUN --mount=type=cache,id=next-cache,target=/app/.next/cache \
    pnpm build

# `output: "standalone"` emitted a traced, minimal node_modules into
# .next/standalone — the runner ships that instead of the full pruned tree
# (issue #1305). Patch the gaps the trace misses (dynamic requires, next's
# subpath shims, the @lion-reader workspace symlinks), then move it out of
# .next so the runner's .next COPY doesn't pick up a duplicate node_modules.
RUN node scripts/fixup-standalone.mjs && mv .next/standalone /standalone

# Build custom server bundle (compression + Next.js wrapper)
RUN pnpm build:server

# Build worker bundle (single optimized JS file)
RUN pnpm build:worker

# Build Discord bot bundle (single optimized JS file)
RUN pnpm build:discord-bot

# Build migration bundle (single optimized JS file)
RUN pnpm build:migrate

# =============================================================================
# Stage 5: Production runner (minimal image, no pnpm needed)
# =============================================================================
FROM node:26-alpine AS runner

WORKDIR /app

# Install bash for startup script and create non-root user
RUN apk add --no-cache bash && \
    addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Set production environment
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# See the global ARG at the top of this file. The runtime server reads it to
# allow the CDN origin in the CSP (src/server/http/csp.ts).
ARG ASSET_PREFIX
ENV ASSET_PREFIX=$ASSET_PREFIX

# Copy necessary files for running the app
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

# Copy the traced standalone node_modules (a fraction of the full tree; see
# the fixup-standalone step in the builder). dist/server.js keeps `next`
# external and resolves it from here; the worker/discord bundles only need
# their few runtime externals (argon2, html-rewriter-wasm, @lion-reader/*),
# which the Next server graph also uses, so the trace covers them.
COPY --from=builder /standalone/node_modules ./node_modules

# The native modules: node_modules/@lion-reader/{sanitizer,readability,feed-parser}
# are pnpm workspace symlinks into these directories, so they must exist in the
# runner.
COPY --from=builder /app/native/sanitizer/package.json ./native/sanitizer/package.json
COPY --from=builder /app/native/sanitizer/index.js ./native/sanitizer/index.js
COPY --from=builder /app/native/sanitizer/index.d.ts ./native/sanitizer/index.d.ts
COPY --from=builder /app/native/sanitizer/sanitizer.node ./native/sanitizer/sanitizer.node
COPY --from=builder /app/native/readability/package.json ./native/readability/package.json
COPY --from=builder /app/native/readability/index.js ./native/readability/index.js
COPY --from=builder /app/native/readability/index.d.ts ./native/readability/index.d.ts
COPY --from=builder /app/native/readability/readability.node ./native/readability/readability.node
COPY --from=builder /app/native/feed-parser/package.json ./native/feed-parser/package.json
COPY --from=builder /app/native/feed-parser/index.js ./native/feed-parser/index.js
COPY --from=builder /app/native/feed-parser/index.d.ts ./native/feed-parser/index.d.ts
COPY --from=builder /app/native/feed-parser/feed-parser.node ./native/feed-parser/feed-parser.node

# Copy built Next.js app
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next

# Copy migrations (SQL files needed at runtime)
COPY --from=builder --chown=nextjs:nodejs /app/migrations ./migrations

# Copy bundled scripts (no longer need tsx, tsconfig, or src/)
COPY --from=builder /app/dist/server.js ./dist/server.js
COPY --from=builder /app/dist/worker.js ./dist/worker.js
COPY --from=builder /app/dist/migrate.js ./dist/migrate.js
COPY --from=builder /app/dist/discord-bot.js ./dist/discord-bot.js

# Copy startup script
COPY --from=builder /app/scripts/start-all.sh ./scripts/start-all.sh
RUN chmod +x scripts/start-all.sh

# No next.config.js in the image: dist/server.js hands next() the resolved
# build-time config from .next/required-server-files.json (the standalone
# mechanism) — the traced node_modules doesn't include the runtime
# config-loading machinery. See scripts/server.ts.

# Switch to non-root user
USER nextjs

# Expose the port
EXPOSE 3000

# Start both API server and background worker
CMD ["./scripts/start-all.sh"]
