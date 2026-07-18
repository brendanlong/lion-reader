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
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

// Per-process secret for the internal revalidate-public endpoint (issue
// #1359). Generated before Next boots so the route handler (same process)
// reads the same value; it never leaves the process, so only the startup hook
// below can call that endpoint. Unconditionally overwritten — honoring an
// externally-set value would silently turn the per-process secret into a
// shared credential.
process.env.INTERNAL_REVALIDATE_SECRET = randomUUID();

/**
 * Re-render the statically-prerendered public pages with runtime env (issue
 * #1359): the login/register HTML bakes the signup/provider config, and the
 * copy from `next build` was rendered with build-machine env (dummy values in
 * CI/Docker). Invalidate them via the internal route, then warm them so the
 * first real visitor gets the cached copy. Retries cover the window where the
 * server has just started listening but Next isn't serving yet. The config
 * can't change after startup, so once per boot is exactly enough.
 */
async function revalidatePublicPages(): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const headers = { "x-internal-secret": process.env.INTERNAL_REVALIDATE_SECRET! };
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(`${base}/api/internal/revalidate-public`, {
        method: "POST",
        headers,
      });
      if (res.ok) {
        const { revalidated } = (await res.json()) as { revalidated: string[] };
        // Warm each page so the re-render happens now, not on the first visitor.
        await Promise.all(revalidated.map((path) => fetch(`${base}${path}`).catch(() => {})));
        logger.info("Revalidated startup-rendered public pages", { revalidated });
        return;
      }
      logger.error("Revalidate-public returned non-OK status", { status: res.status });
      return;
    } catch (error) {
      if (attempt === 5) {
        // The pages keep serving build-baked config until the next boot — loud
        // error so it's investigated, but not fatal (everything else works).
        logger.error("Failed to revalidate public pages at startup", {
          error: error instanceof Error ? error.message : "Unknown error",
        });
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
}

// How long in-flight requests and SSE streams get to finish before their
// connections are severed. Must fit inside fly.toml's kill_timeout (with room
// for the resource cleanup that follows). Short in dev so Ctrl+C is snappy.
const DRAIN_TIMEOUT_MS = dev ? 1_000 : 15_000;
// Hard deadline for the whole shutdown (drain + pool/Redis cleanup).
const FORCE_EXIT_TIMEOUT_MS = DRAIN_TIMEOUT_MS + 10_000;

// In production we run against Next's `output: "standalone"` build, whose
// traced node_modules deliberately omits the runtime config-loading machinery
// (next/dist/compiled/webpack etc.). Hand `next()` the resolved build-time
// config via __NEXT_PRIVATE_STANDALONE_CONFIG — the same mechanism the
// generated .next/standalone/server.js uses — so it never tries to load
// next.config.js at runtime.
if (!dev) {
  const manifestPath = join(process.cwd(), ".next", "required-server-files.json");
  let requiredServerFiles: { config: Record<string, unknown> };
  try {
    requiredServerFiles = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      config: Record<string, unknown>;
    };
  } catch (error) {
    throw new Error(
      `Failed to read ${manifestPath} — the production server needs a completed ` +
        `\`next build\` in the working directory. Original error: ${String(error)}`
    );
  }
  process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = JSON.stringify(requiredServerFiles.config);
}

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
    // Re-render the public pages with runtime env (see revalidatePublicPages).
    // Dev has no prerender cache — every request renders fresh — so skip it.
    if (!dev) {
      void revalidatePublicPages();
    }
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
