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
import { stripOauthSurfaceTrailingSlash } from "../src/server/http/trailing-slash";
import {
  startMaintenancePoller,
  getCurrentMaintenance,
  evaluateRequest,
  renderMaintenanceHtml,
  maintenanceJsonBody,
} from "../src/server/maintenance/server-gate";
import { getResourceCleanup } from "../src/server/shutdown";
import { logger } from "../src/lib/logger";

const dev = process.env.NODE_ENV !== "production";
const hostname = process.env.HOSTNAME || "0.0.0.0";
const port = parseInt(process.env.PORT || "3000", 10);

// How long in-flight requests and SSE streams get to finish before their
// connections are severed. Must fit inside fly.toml's kill_timeout (with room
// for the resource cleanup that follows). Short in dev so Ctrl+C is snappy.
const DRAIN_TIMEOUT_MS = dev ? 1_000 : 15_000;
// Hard deadline for the whole shutdown (drain + pool/Redis cleanup).
const FORCE_EXIT_TIMEOUT_MS = DRAIN_TIMEOUT_MS + 10_000;

const app = next({
  dev,
  hostname,
  port,
  turbopack: dev,
});

app.prepare().then(() => {
  const handle = app.getRequestHandler();
  const upgrade = app.getUpgradeHandler();

  // Poll Redis for the maintenance flag so the per-request check below stays
  // synchronous (no await on the hot path).
  startMaintenancePoller();

  const server = createServer((req, res) => {
    // OAuth/MCP endpoints must answer trailing-slash URLs in place instead of
    // Next's default 308 (server-to-server OAuth clients don't follow
    // redirects on POST). Normalizing req.url here keeps the built-in
    // trailing-slash redirect intact for the rest of the site — see
    // src/server/http/trailing-slash.ts.
    if (req.url) {
      req.url = stripOauthSurfaceTrailingSlash(req.url);
    }

    // Maintenance mode: short-circuit everything except the exempt surfaces
    // (demo, admin, health, static). Demo stays up because it never touches the
    // database, which is the whole point during a DB migration.
    const maintenance = getCurrentMaintenance();
    if (maintenance.enabled) {
      const pathname = (req.url || "/").split("?")[0];
      const decision = evaluateRequest(pathname, req.headers.cookie, req.headers.authorization);
      if (decision !== "allow") {
        res.statusCode = 503;
        res.setHeader("Retry-After", "3600");
        res.setHeader("Cache-Control", "no-store");
        // These responses short-circuit before Next's handler, so they miss the
        // security headers from next.config.ts and the nonce'd CSP from
        // src/proxy.ts. Set the framing/sniffing protections here too so
        // maintenance-mode pages aren't a coverage gap. The maintenance HTML
        // has no scripts at all (inline <style> only), so this static policy
        // can be stricter than the app's (`script-src 'none'`); keep it
        // conceptually in sync with src/server/http/csp.ts.
        res.setHeader("X-Frame-Options", "DENY");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader(
          "Content-Security-Policy",
          "script-src 'none'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
        );
        if (decision === "block-api") {
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(maintenanceJsonBody(maintenance.message));
        } else {
          res.setHeader("Content-Type", "text/html; charset=utf-8");
          res.end(renderMaintenanceHtml(maintenance.message));
        }
        return;
      }
    }

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

  // Graceful shutdown: stop accepting connections, let in-flight requests
  // drain, sever long-lived connections (SSE streams never end on their own —
  // destroying their sockets aborts the requests, which unsubscribes them
  // from Redis), and only then close shared resources.
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`Received ${signal}, shutting down server...`, {
      drainTimeoutMs: DRAIN_TIMEOUT_MS,
    });

    // Hard deadline in case a connection or pool refuses to close.
    setTimeout(() => {
      logger.error("Shutdown did not complete in time, forcing exit");
      process.exit(1);
    }, FORCE_EXIT_TIMEOUT_MS).unref();

    // Stop accepting new connections. The callback fires once every existing
    // connection has closed.
    server.close(() => {
      void (async () => {
        try {
          // Close DB pool / Redis / metrics server, all registered by
          // instrumentation.ts in the Next.js runtime module graph (a separate
          // copy from this bundle's modules in production). The metrics server
          // (port 9091) is started AND stopped there so it shares the registry
          // the route handlers write to — see src/instrumentation.ts.
          const cleanup = getResourceCleanup();
          if (cleanup) {
            await cleanup();
          }
          logger.info("Graceful shutdown complete");
          process.exit(0);
        } catch (error) {
          logger.error("Error during shutdown", { error });
          process.exit(1);
        }
      })();
    });

    // Idle keep-alive connections would otherwise hold the server open until
    // their sockets time out.
    server.closeIdleConnections();

    // Sever whatever is still open (SSE, slow requests) after the drain
    // period.
    setTimeout(() => server.closeAllConnections(), DRAIN_TIMEOUT_MS).unref();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
});
