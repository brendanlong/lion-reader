# Production Dockerfile for Lion Reader
# Multi-stage build for optimal image size

# =============================================================================
# Stage 1: Base image with pnpm (for building)
# =============================================================================
FROM node:20-alpine AS base

# Enable corepack and prepare the exact pnpm version from package.json
RUN corepack enable && corepack prepare pnpm@10.26.2 --activate

# Set working directory
WORKDIR /app

# =============================================================================
# Stage 2: Install dependencies
# =============================================================================
FROM base AS deps

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Install all dependencies (including devDependencies for building)
# Use --ignore-scripts because postinstall needs files not yet copied
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --ignore-scripts

# =============================================================================
# Stage 3: Build the application
# =============================================================================
FROM base AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source code
COPY . .

# Run postinstall script (copies ONNX WASM files to public/)
RUN node scripts/copy-onnx-wasm.mjs

# Set environment for build
ENV NEXT_TELEMETRY_DISABLED=1
ENV NODE_ENV=production
# Dummy URLs for build - modules check these exist but don't connect
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
ENV REDIS_URL="redis://localhost:6379"

# Build Next.js application
RUN pnpm build

# Build worker bundle (single optimized JS file)
RUN pnpm build:worker

# Build Discord bot bundle (single optimized JS file)
RUN pnpm build:discord-bot

# Build migration bundle (single optimized JS file)
RUN pnpm build:migrate

# Prune dev dependencies after build
RUN --mount=type=cache,id=pnpm,target=/root/.local/share/pnpm/store \
    pnpm prune --prod --ignore-scripts

# =============================================================================
# Stage 4: Production runner (minimal image, no pnpm needed)
# =============================================================================
FROM node:20-alpine AS runner

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

# Copy built Next.js app
COPY --from=builder --chown=nextjs:nodejs /app/.next ./.next

# Copy drizzle migrations (SQL files needed at runtime)
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

# Copy bundled scripts (no longer need tsx, tsconfig, or src/)
COPY --from=builder /app/dist/worker.js ./dist/worker.js
COPY --from=builder /app/dist/migrate.js ./dist/migrate.js
COPY --from=builder /app/dist/discord-bot.js ./dist/discord-bot.js

# Copy startup script
COPY --from=builder /app/scripts/start-all.sh ./scripts/start-all.sh
RUN chmod +x scripts/start-all.sh

# Switch to non-root user
USER nextjs

# Expose the port
EXPOSE 3000

# Start both API server and background worker
CMD ["./scripts/start-all.sh"]
