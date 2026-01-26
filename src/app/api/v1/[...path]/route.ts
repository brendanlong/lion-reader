/**
 * REST API Route Handler
 *
 * This handles REST requests for the public API.
 * Routes are defined using the openapi meta on tRPC procedures.
 *
 * Currently only exposes:
 * - POST /api/v1/saved - Save URL for later (used by browser extension)
 */

import { createOpenApiFetchHandler } from "trpc-to-openapi";
import { appRouter, createContext } from "@/server/trpc";

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
 * Handle OPTIONS preflight requests for CORS.
 */
export async function OPTIONS(req: Request) {
  const url = new URL(req.url);

  if (needsCorsHeaders(url)) {
    return new Response(null, { status: 204, headers: SAVED_CORS_HEADERS });
  }

  return new Response(null, { status: 204 });
}

/**
 * Handle REST API requests.
 */
const handler = async (req: Request) => {
  const url = new URL(req.url);

  const response = await createOpenApiFetchHandler({
    endpoint: "/api/v1",
    req,
    router: appRouter,
    createContext,
    onError:
      process.env.NODE_ENV === "development"
        ? ({ error, path }) => {
            console.error(`❌ REST API failed on ${path ?? "<no-path>"}: ${error.message}`);
          }
        : undefined,
  });

  // Add CORS headers if needed
  if (needsCorsHeaders(url)) {
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SAVED_CORS_HEADERS)) {
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
