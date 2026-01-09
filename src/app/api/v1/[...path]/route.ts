/**
 * REST API Route Handler
 *
 * This handles REST requests for the public API.
 * Routes are defined using the openapi meta on tRPC procedures.
 * Includes rate limit headers in all responses.
 * Tracks HTTP metrics when METRICS_ENABLED=true.
 */

import { createOpenApiFetchHandler } from "trpc-to-openapi";
import { TRPCError } from "@trpc/server";
import { appRouter, createContext } from "@/server/trpc";
import { startHttpTimer } from "@/server/metrics";

/**
 * Extracts rate limit headers from a tRPC error (if present).
 */
function extractRateLimitHeaders(error: TRPCError): Record<string, string> {
  if (error.cause && typeof error.cause === "object" && "headers" in error.cause) {
    return (error.cause as { headers: Record<string, string> }).headers;
  }
  return {};
}

/**
 * Normalizes the REST API path for metrics.
 * Replaces dynamic segments (UUIDs) with placeholders to avoid high cardinality.
 *
 * Example: /api/v1/subscriptions/550e8400-e29b-41d4-a716-446655440000 → /api/v1/subscriptions/:id
 */
function normalizeRestPath(url: URL): string {
  const pathname = url.pathname;

  // UUID pattern: 8-4-4-4-12 hex chars
  const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

  // Replace UUIDs with :id placeholder
  return pathname.replace(uuidPattern, ":id");
}

/**
 * Handle REST API requests with rate limit header handling.
 */
const handler = async (req: Request) => {
  let rateLimitHeaders: Record<string, string> = {};

  // Start timing for metrics (no-op if metrics disabled)
  const url = new URL(req.url);
  const normalizedPath = normalizeRestPath(url);
  const endTimer = startHttpTimer(req.method, normalizedPath);

  const response = await createOpenApiFetchHandler({
    endpoint: "/api/v1",
    req,
    router: appRouter,
    createContext,
    onError:
      process.env.NODE_ENV === "development"
        ? ({ error, path }) => {
            console.error(`❌ REST API failed on ${path ?? "<no-path>"}: ${error.message}`);

            // Extract rate limit headers from error
            if (error.code === "TOO_MANY_REQUESTS") {
              rateLimitHeaders = extractRateLimitHeaders(error);
            }
          }
        : ({ error }) => {
            // Extract rate limit headers from error in production too
            if (error.code === "TOO_MANY_REQUESTS") {
              rateLimitHeaders = extractRateLimitHeaders(error);
            }
          },
  });

  // Record HTTP metrics
  endTimer(response.status);

  // Add rate limit headers to the response
  if (Object.keys(rateLimitHeaders).length > 0) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(rateLimitHeaders)) {
      headers.set(key, value);
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }

  return response;
};

export { handler as GET, handler as POST, handler as PUT, handler as PATCH, handler as DELETE };
