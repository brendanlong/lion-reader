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
 * Check if an origin is a browser extension origin.
 * Extensions use chrome-extension:// (Chrome/Edge) or moz-extension:// (Firefox).
 */
function isExtensionOrigin(origin: string | null): boolean {
  if (!origin) return false;
  return origin.startsWith("chrome-extension://") || origin.startsWith("moz-extension://");
}

/**
 * Get CORS headers for browser extension requests to the /saved endpoint.
 * We only allow extensions to access this specific endpoint to minimize attack surface.
 * Even a malicious extension can only save articles, not read user data.
 */
function getCorsHeaders(req: Request): Record<string, string> | null {
  const url = new URL(req.url);
  const origin = req.headers.get("Origin");

  // Only add CORS headers for the /saved endpoint
  if (!url.pathname.endsWith("/saved")) {
    return null;
  }

  // Only allow browser extension origins (isExtensionOrigin checks for null)
  if (!isExtensionOrigin(origin)) {
    return null;
  }

  return {
    "Access-Control-Allow-Origin": origin as string,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

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
 * Add extra headers to a response, returning a new Response object.
 */
function addHeaders(response: Response, extraHeaders: Record<string, string>): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Handle OPTIONS preflight requests for CORS.
 */
const optionsHandler = async (req: Request) => {
  const corsHeaders = getCorsHeaders(req);

  if (corsHeaders) {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // No CORS for this endpoint/origin - return 204 with no CORS headers
  return new Response(null, { status: 204 });
};

/**
 * Handle REST API requests with rate limit header handling.
 */
const handler = async (req: Request) => {
  let rateLimitHeaders: Record<string, string> = {};

  // Start timing for metrics (no-op if metrics disabled)
  const url = new URL(req.url);
  const normalizedPath = normalizeRestPath(url);
  const endTimer = startHttpTimer(req.method, normalizedPath);

  // Check if we need to add CORS headers
  const corsHeaders = getCorsHeaders(req);

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

  // Combine all extra headers
  const extraHeaders = { ...rateLimitHeaders, ...corsHeaders };

  if (Object.keys(extraHeaders).length > 0) {
    return addHeaders(response, extraHeaders);
  }

  return response;
};

export {
  optionsHandler as OPTIONS,
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
