/**
 * Shared server-side Sentry initialization.
 *
 * Used by every server-side process:
 * - Next.js app server: via sentry.server.config.ts / sentry.edge.config.ts,
 *   loaded from src/instrumentation.ts
 * - Background worker: scripts/worker.ts
 * - Discord bot: scripts/discord-bot.ts
 *
 * The worker and bot must call this themselves — Next.js instrumentation only
 * runs in the app server, so without an explicit init their
 * `Sentry.captureException` calls are silent no-ops.
 */

import * as Sentry from "@sentry/nextjs";

/**
 * Initializes Sentry if SENTRY_DSN is set. Safe to call more than once
 * (subsequent calls re-init the same client) and a no-op without a DSN.
 */
export function initSentry(): void {
  if (!process.env.SENTRY_DSN) {
    return;
  }

  Sentry.init({
    dsn: process.env.SENTRY_DSN,

    // Adjust this value in production, or use tracesSampler for greater control
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,

    // Environment tag for filtering
    environment: process.env.NODE_ENV,

    // Only send errors from production
    enabled: process.env.NODE_ENV === "production",

    // Configure which errors to ignore
    beforeSend(event, hint) {
      const error = hint.originalException;

      // Don't report 4xx client errors (these are expected)
      if (error instanceof Error) {
        const errorMessage = error.message.toLowerCase();
        if (
          errorMessage.includes("unauthorized") ||
          errorMessage.includes("not found") ||
          errorMessage.includes("bad request") ||
          errorMessage.includes("forbidden")
        ) {
          return null;
        }
      }

      return event;
    },

    // Ignore common expected errors
    ignoreErrors: [
      // Connection errors during health checks
      "ECONNREFUSED",
      // Redis connection errors during shutdown
      "Connection is closed",
    ],
  });
}
