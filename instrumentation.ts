/**
 * Next.js Instrumentation
 *
 * This file is used to initialize server-side instrumentation like Sentry.
 * It runs before any server-side code in Next.js.
 *
 * The background job worker runs as a separate process (see scripts/worker.ts).
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Import the server Sentry config
    await import("./sentry.server.config");

    // Initialize plugins (happens at module import time)
    await import("./src/server/plugins");

    const { logger } = await import("./src/lib/logger");

    // Handle graceful shutdown to close DB/Redis connections
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return; // Prevent duplicate shutdown attempts
      shuttingDown = true;
      logger.info("Shutting down Next.js server...");

      try {
        // Close Redis connection
        const { redis } = await import("./src/server/redis");
        await redis.quit();

        // Close database pool
        const { pool } = await import("./src/server/db");
        await pool.end();

        logger.info("Graceful shutdown complete");
      } catch (error) {
        logger.error("Error during shutdown", { error });
      }
      process.exit(0);
    };

    process.on("SIGTERM", () => void shutdown());
    process.on("SIGINT", () => void shutdown());
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    // Import the edge Sentry config
    await import("./sentry.edge.config");
  }
}
