/**
 * Internal metrics HTTP server
 *
 * Runs a minimal HTTP server on an internal port (not exposed via Fly.io's
 * http_service) for Prometheus scraping. This keeps metrics off the public
 * internet while allowing Fly.io's internal scraper to collect them.
 */

import { createServer, type Server } from "node:http";
import { metricsEnabled, registry } from "./metrics";
import { collectAllMetrics } from "./collect";
import { logger } from "@/lib/logger";

let server: Server | null = null;

/**
 * Starts the internal metrics HTTP server.
 *
 * The server responds to GET /metrics with Prometheus-formatted metrics.
 * All other requests return 404.
 *
 * @param port - Port to listen on (default: 9091)
 * @returns The server instance, or null if metrics are disabled
 */
export function startMetricsServer(port = 9091): Server | null {
  if (!metricsEnabled) {
    logger.info("Metrics disabled, skipping internal metrics server");
    return null;
  }

  if (server) {
    logger.warn("Metrics server already running");
    return server;
  }

  server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/metrics") {
      try {
        // Collect business metrics from database
        await collectAllMetrics();

        const metrics = await registry.metrics();
        res.writeHead(200, { "Content-Type": registry.contentType });
        res.end(metrics);
      } catch (error) {
        logger.error("Failed to collect metrics", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        res.writeHead(500, { "Content-Type": "text/plain" });
        res.end("Internal Server Error");
      }
    } else if (req.method === "GET" && req.url === "/health") {
      // Simple health check for Fly.io - just confirms the process is running
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "healthy" }));
    } else {
      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not Found");
    }
  });

  server.listen(port, () => {
    logger.info("Internal metrics server started", { port });
  });

  return server;
}

/**
 * Stops the internal metrics HTTP server.
 */
export function stopMetricsServer(): Promise<void> {
  return new Promise((resolve) => {
    if (!server) {
      resolve();
      return;
    }

    server.close(() => {
      logger.info("Internal metrics server stopped");
      server = null;
      resolve();
    });
  });
}
