/**
 * Sentry Client Configuration
 *
 * This file configures the initialization of Sentry on the client (browser).
 * The config added here applies whenever a user loads a page in their browser.
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/
 */

import * as Sentry from "@sentry/nextjs";

// Only initialize Sentry if DSN is provided
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // Adjust this value in production, or use tracesSampler for greater control
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,

    // Enable replay for 10% of sessions
    replaysSessionSampleRate: 0.1,

    // If you're not already sampling the entire session, change the sample rate to 100%
    // when sampling sessions where errors occur.
    replaysOnErrorSampleRate: 1.0,

    // Environment tag for filtering
    environment: process.env.NODE_ENV,

    // Only send errors from production
    enabled: process.env.NODE_ENV === "production",

    // Filter out common client-side noise
    beforeSend(event) {
      // Don't send events from browser extensions
      if (
        event.exception?.values?.some((exception) =>
          exception.stacktrace?.frames?.some(
            (frame) =>
              frame.filename?.includes("chrome-extension://") ||
              frame.filename?.includes("moz-extension://")
          )
        )
      ) {
        return null;
      }
      return event;
    },

    // Ignore common benign errors
    ignoreErrors: [
      // Network errors that happen when user goes offline
      "Failed to fetch",
      "Load failed",
      "NetworkError",
      // User cancelled request
      "AbortError",
      // Browser extensions
      "Extension context invalidated",
      // React hydration mismatches (usually benign)
      "Minified React error",
    ],
  });
}
