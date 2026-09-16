/**
 * Client Instrumentation (Next.js convention, replaces sentry.client.config.ts)
 *
 * Runs in the browser before the app hydrates. This is where client-side
 * Sentry is initialized. Like src/instrumentation.ts, Next.js resolves this
 * file from `src/` first, then the repo root.
 *
 * https://nextjs.org/docs/app/guides/instrumentation-client
 * https://docs.sentry.io/platforms/javascript/guides/nextjs/
 */

import * as Sentry from "@sentry/nextjs";

// Only initialize Sentry if DSN is provided.
// NEXT_PUBLIC_* vars are inlined at build time, so the DSN must be available
// to `next build` (not just at runtime) for client Sentry to work.
if (process.env.NEXT_PUBLIC_SENTRY_DSN) {
  Sentry.init({
    dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,

    // Adjust this value in production, or use tracesSampler for greater control
    tracesSampleRate: process.env.NODE_ENV === "production" ? 0.1 : 1.0,

    // Setting this option to true will print useful information to the console while you're setting up Sentry.
    debug: false,

    // Session Replay. The sample rates below do nothing without this
    // integration being registered.
    integrations: [Sentry.replayIntegration()],

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

// Instruments Next.js router transitions for tracing. Most in-app navigation
// here bypasses the Next router (ClientLink uses pushState directly), so this
// mainly covers initial-load route changes; exported to follow the convention.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
