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

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Import the server Sentry config
    await import("../sentry.server.config");

    // Initialize plugins (happens at module import time)
    await import("./server/plugins");

    const { logger } = await import("./lib/logger");

    // The internal Prometheus metrics server (port 9091) is started by the
    // custom server (scripts/server.ts), NOT here: in production this module
    // and the custom server bundle are separate module graphs, so starting it
    // in both places would try to bind the port twice.

    // Register resource cleanup for graceful shutdown. The custom server
    // (scripts/server.ts) owns the signal handlers and the HTTP server; it
    // calls this only after the HTTP server has stopped accepting and drained
    // its connections (including SSE streams), so in-flight requests never
    // see a closed pool.
    const { registerResourceCleanup } = await import("./server/shutdown");
    registerResourceCleanup(async () => {
      logger.info("Closing shared resources...");

      // Close Redis connection
      const { redis } = await import("./server/redis");
      await redis.quit();

      // Close database pool
      const { pool } = await import("./server/db");
      await pool.end();
    });
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    // Import the edge Sentry config
    await import("../sentry.edge.config");
  }
}
