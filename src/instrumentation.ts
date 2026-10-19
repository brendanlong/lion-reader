/**
 * Next.js Instrumentation
 *
 * This file is used to initialize server-side instrumentation like Sentry.
 * It runs before any server-side code in Next.js.
 *
 * NOTE: this file must live in `src/` (next to `src/app`), not the repo root —
 * Next.js only looks for the instrumentation hook in the directory that
 * contains the `app` directory, so a root-level instrumentation.ts is silently
 * ignored (same resolution rule as `src/proxy.ts`).
 *
 * The background job worker runs as a separate process (see scripts/worker.ts).
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Import the server Sentry config
    await import("../sentry.server.config");

    // Initialize plugins (happens at module import time)
    await import("./server/plugins");

    // Start the internal Prometheus metrics server (port 9091) HERE, in the
    // Next.js runtime module graph — NOT in the custom server (scripts/server.ts).
    // The HTTP request metrics (http_requests_total / http_request_duration_seconds)
    // are observed by the tRPC and REST route handlers, which run in THIS module
    // graph. In production the custom server bundle is a separate module graph
    // with its own copy of the metrics registry, so starting the metrics server
    // there scraped an orphaned registry: the HTTP metrics (recorded into this
    // graph's registry) never appeared, while business/default metrics happened
    // to work because they're collected inside the scrape handler itself.
    // Colocating the server with the route handlers means one registry holds
    // everything the app process emits. The worker/discord processes are single
    // bundles and start theirs in runProcess (src/server/process.ts).
    const { startMetricsServer } = await import("./server/metrics/server");
    startMetricsServer(9091);

    // Register resource cleanup for graceful shutdown. The custom server
    // (scripts/server.ts) owns the signal handlers and the HTTP server; it
    // calls this only after the HTTP server has stopped accepting and drained
    // its connections (including SSE streams), so in-flight requests never
    // see a closed pool.
    const { registerResourceCleanup } = await import("./server/shutdown");
    const { closeSharedResources } = await import("./server/process");
    registerResourceCleanup(closeSharedResources);
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    // Import the edge Sentry config
    await import("../sentry.edge.config");
  }
}

// Capture errors from Server Components, route handlers, middleware, and
// proxies. Without this export, only errors that flow through explicit
// captureException call sites (e.g. the tRPC error middleware) reach Sentry.
export const onRequestError = Sentry.captureRequestError;
