/**
 * tRPC API Route Handler
 *
 * This is the main entry point for tRPC requests.
 * All tRPC procedures are accessible at /api/trpc/*
 * Includes rate limit headers in error responses.
 */

import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { TRPCError } from "@trpc/server";
import { appRouter, createContext } from "@/server/trpc";

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
 * Handle tRPC requests for all HTTP methods with rate limit header handling.
 */
const handler = async (req: Request) => {
  let rateLimitHeaders: Record<string, string> = {};

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
