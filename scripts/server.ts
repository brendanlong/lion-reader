/**
 * Custom HTTP server wrapping Next.js with streaming compression.
 *
 * Applies zstd/brotli/gzip/deflate compression to chunked SSR responses.
 * Non-streaming responses (static assets, API responses with Content-Length)
 * are left uncompressed for Fly.io's edge to handle.
 *
 * Works for both development (`pnpm dev:next`) and production (`pnpm start`).
 *
 * Usage:
 *   NODE_ENV=development tsx scripts/server.ts   # dev with turbopack
 *   node dist/server.js                          # production
 */

import next from "next";
import { createServer } from "node:http";
import { maybeCompressResponse } from "../src/server/http/compression";
import { startMetricsServer } from "../src/server/metrics/server";
import { logger } from "../src/lib/logger";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

const app = next({
  dev,
  hostname,
  port,
  turbopack: dev,
});

app.prepare().then(() => {
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  const server = createServer((req, res) => {
    maybeCompressResponse(req, res);
    handle(req, res);
  });

  // Handle WebSocket upgrades (needed for HMR in development)
  server.on("upgrade", (req, socket, head) => {
    upgrade(req, socket, head);
  });

  server.listen(port, hostname, () => {
    logger.info(`Server started on http://${hostname}:${port}`, {
      dev,
      hostname,
      port,
    });
  });

  // Start internal metrics server for Prometheus scraping (port 9091)
  startMetricsServer(9091);
});
