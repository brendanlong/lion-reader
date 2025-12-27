/**
 * Sentry Server Configuration
 *
 * This file configures the initialization of Sentry on the server.
 * The config added here applies to all server-side code.
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/
 */

import * as Sentry from "@sentry/nextjs";

// Only initialize Sentry if DSN is provided
if (process.env.SENTRY_DSN) {
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
