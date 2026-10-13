/**
 * The browser Sentry SDK and its configuration. Only ever loaded through
 * `loadSentry()` (`./client.ts`), so it stays out of the critical-path bundle.
 * Named imports (not `import * as`) let webpack tree-shake the SDK in this
 * async chunk.
 */

import { captureException, captureRouterTransitionStart, init } from "@sentry/nextjs";

export { captureException, captureRouterTransitionStart };

export function initSentry(dsn: string): void {
  init({
    dsn,

    // Adjust this value in production, or use tracesSampler for greater control
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,

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
