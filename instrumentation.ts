/**
 * Next.js Instrumentation
 *
 * This file is used to initialize server-side instrumentation like Sentry.
 * It runs before any server-side code in Next.js.
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Import the server Sentry config
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    // Import the edge Sentry config
    await import("./sentry.edge.config");
  }
}
