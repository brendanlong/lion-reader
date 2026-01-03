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

    // Start the background worker for feed fetching
    // Only start in non-test environments and when not using a separate worker process
    const useEmbeddedWorker = process.env.DISABLE_EMBEDDED_WORKER !== "true";
    if (process.env.NODE_ENV !== "test" && useEmbeddedWorker) {
      const { createWorker } = await import("./src/server/jobs/worker");
      const { logger } = await import("./src/lib/logger");

      const worker = createWorker({
        pollIntervalMs: 5000, // Poll every 5 seconds
        concurrency: 3, // Process up to 3 jobs concurrently
      });

      // Start the worker
      worker.start().catch((error) => {
        logger.error("Failed to start background worker", { error });
      });

      // Handle graceful shutdown
      const shutdown = async () => {
        logger.info("Shutting down background worker...");
        await worker.stop();
      };

      process.on("SIGTERM", shutdown);
      process.on("SIGINT", shutdown);

      logger.info("Background worker initialized");
    }
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    // Import the edge Sentry config
    await import("./sentry.edge.config");
  }
}
