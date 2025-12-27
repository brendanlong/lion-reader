/**
 * Sentry Edge Configuration
 *
 * This file configures the initialization of Sentry for edge features (middleware, edge routes).
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
  });
}
