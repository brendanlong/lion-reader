/**
 * Next.js Instrumentation
 *
 * This file is used to initialize server-side instrumentation like Sentry
 * and the background job worker. It runs before any server-side code in Next.js.
 *
 * https://nextjs.org/docs/app/building-your-application/optimizing/instrumentation
 */

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    // Import the server Sentry config
    await import("./sentry.server.config");

    const { logger } = await import("./src/lib/logger");

    // Start the background worker for feed fetching
    // Only start in non-test environments and when not using a separate worker process
    const useEmbeddedWorker = process.env.DISABLE_EMBEDDED_WORKER !== "true";
    let worker: Awaited<ReturnType<typeof import("./src/server/jobs/worker").createWorker>> | null =
      null;

    if (process.env.NODE_ENV !== "test" && useEmbeddedWorker) {
      const { createWorker } = await import("./src/server/jobs/worker");

      worker = createWorker({
        pollIntervalMs: 5000, // Poll every 5 seconds
        concurrency: 3, // Process up to 3 jobs concurrently
      });

      // Start the worker
      worker.start().catch((error) => {
        logger.error("Failed to start background worker", { error });
      });

      logger.info("Background worker initialized");
    }

    // Handle graceful shutdown - always register to close DB/Redis connections
    let shuttingDown = false;
    const shutdown = async () => {
      if (shuttingDown) return; // Prevent duplicate shutdown attempts
      shuttingDown = true;
      logger.info("Shutting down Next.js server...");

      try {
        // Stop worker if running
        if (worker) {
          await worker.stop();
        }

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
