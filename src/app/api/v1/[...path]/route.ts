/**
 * REST API Route Handler
 *
 * This handles REST requests for the public API.
 * Routes are defined using the openapi meta on tRPC procedures.
 */

import { createOpenApiFetchHandler } from "trpc-to-openapi";
import { appRouter } from "@/server/trpc/root";
import { createContext } from "@/server/trpc/context";
import { getHTTPStatusCodeFromError } from "@trpc/server/http";
import { getAppErrorCode } from "@/server/errors";
import { serveTrpcHttp } from "@/server/trpc/http";

/**
 * CORS headers for the /saved endpoint.
 * Since we use Bearer token auth (not cookies), any origin can make requests.
 * The token itself provides the security.
 */
const SAVED_CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

/**
 * Check if this request is to the /saved endpoint and needs CORS headers.
 */
function needsCorsHeaders(url: URL): boolean {
  return url.pathname.endsWith("/saved");
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
 * Handle OPTIONS preflight requests for CORS.
 */
const optionsHandler = async (req: Request) => {
  const url = new URL(req.url);

  if (needsCorsHeaders(url)) {
    return new Response(null, { status: 204, headers: SAVED_CORS_HEADERS });
  }

  return new Response(null, { status: 204 });
};

const handler = (req: Request): Promise<Response> => {
  const url = new URL(req.url);
  return serveTrpcHttp(
    req,
    {
      label: "REST API",
      metricsPath: normalizeRestPath(url),
      extraHeaders: needsCorsHeaders(url) ? SAVED_CORS_HEADERS : undefined,
      // The adapter's own error shape: it would report a failing body read as
      // a parse error.
      rejectOversized: (error) =>
        Response.json(
          {
            message: error.message,
            code: error.code,
            data: { appErrorCode: getAppErrorCode(error) },
          },
          { status: getHTTPStatusCodeFromError(error) }
        ),
    },
    (onError) =>
      createOpenApiFetchHandler({
        endpoint: "/api/v1",
        req,
        router: appRouter,
        createContext,
        onError,
      })
  );
};

export {
  optionsHandler as OPTIONS,
  handler as GET,
  handler as POST,
  handler as PUT,
  handler as PATCH,
  handler as DELETE,
};
