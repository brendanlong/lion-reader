# Production Dockerfile for Lion Reader
# Multi-stage build for optimal image size

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

# Client-side Sentry DSN. NEXT_PUBLIC_* vars are inlined into the client
# bundle at build time, so a runtime secret is not enough — the DSN must be
# provided to the build (fly.toml [build.args]). DSNs are not secret (they
# ship in the client bundle by design). Empty means client Sentry is disabled.
ARG NEXT_PUBLIC_SENTRY_DSN=""
ENV NEXT_PUBLIC_SENTRY_DSN=$NEXT_PUBLIC_SENTRY_DSN

# Build Next.js application. The cache mount persists .next/cache (webpack's
# persistent build cache) across builds, cutting warm build times — and keeps
# it out of the image layers (it's build-time-only; the runtime recreates the
# dir if it needs it).
RUN --mount=type=cache,id=next-cache,target=/app/.next/cache \
    pnpm build

# Build custom server bundle (compression + Next.js wrapper)
RUN pnpm build:server

# Build worker bundle (single optimized JS file)
RUN pnpm build:worker

# Build Discord bot bundle (single optimized JS file)
RUN pnpm build:discord-bot

# Build migration bundle (single optimized JS file)
RUN pnpm build:migrate

# Prune dev dependencies after build. CI=true lets pnpm remove/recreate the
# modules directory without a confirmation prompt (there's no TTY in the
# builder; without it prune fails with ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY).
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    CI=true pnpm prune --prod --ignore-scripts

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

# Copy necessary files for running the app
COPY --from=builder /app/public ./public
COPY --from=builder /app/package.json ./package.json

# Copy production node_modules (already pruned in builder)
COPY --from=builder /app/node_modules ./node_modules

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

# Generate minimal next.config.js for runtime.
# The full next.config.ts requires TypeScript and build-time-only deps (next-pwa,
# sentry). Only compress:false is needed at runtime — everything else (headers,
# webpack, etc.) is baked into .next/ at build time.
RUN echo 'module.exports = { compress: false };' > next.config.js

# Switch to non-root user
USER nextjs

# Expose the port
EXPOSE 3000

# Start both API server and background worker
CMD ["./scripts/start-all.sh"]
