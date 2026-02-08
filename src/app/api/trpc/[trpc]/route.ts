/**
 * tRPC API Route Handler
 *
 * This is the main entry point for tRPC requests.
 * All tRPC procedures are accessible at /api/trpc/*
 * Includes rate limit headers in error responses.
 * Tracks HTTP metrics when METRICS_ENABLED=true.
 */

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";
import { appRouter } from "@/server/trpc/root";
import { createContext } from "@/server/trpc/context";
import { startHttpTimer } from "@/server/metrics/metrics";

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
 * Normalizes the tRPC path for metrics.
 * Extracts the procedure name from the URL path.
 *
 * Example: /api/trpc/entries.list,entries.get → /api/trpc/entries.list
 * (For batched requests, we use the first procedure as the path)
 */
function normalizeTrpcPath(url: URL): string {
  const pathname = url.pathname;
  // Extract procedure from path like /api/trpc/entries.list
  const trpcPath = pathname.replace("/api/trpc/", "");

  // For batched requests (comma-separated), use the first procedure
  const firstProcedure = trpcPath.split(",")[0] || "unknown";

  return `/api/trpc/${firstProcedure}`;
}

/**
 * Handle tRPC requests for all HTTP methods with rate limit header handling.
 */
const handler = async (req: Request) => {
  let rateLimitHeaders: Record<string, string> = {};

  // Start timing for metrics (no-op if metrics disabled)
  const url = new URL(req.url);
  const normalizedPath = normalizeTrpcPath(url);
  const endTimer = startHttpTimer(req.method, normalizedPath);

  const response = await fetchRequestHandler({
    endpoint: "/api/trpc",
    req,
    router: appRouter,
    createContext,
    onError:
      process.env.NODE_ENV === "development"
        ? ({ path, error }) => {
            console.error(`❌ tRPC failed on ${path ?? "<no-path>"}: ${error.message}`);

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

export { handler as GET, handler as POST };
