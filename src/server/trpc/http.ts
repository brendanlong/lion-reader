/**
 * The HTTP wrapping shared by the tRPC (`/api/trpc`) and REST (`/api/v1`)
 * route handlers, which serve the same router.
 */

import type { TRPCError } from "@trpc/server";
import { startHttpTimer } from "@/server/metrics/metrics";

type TrpcErrorHandler = (opts: { error: TRPCError; path?: string }) => void;

/** The headers the rate-limit middleware (`trpc.ts`) puts on its error's cause. */
function rateLimitHeaders(error: TRPCError): Record<string, string> {
  if (error.cause && typeof error.cause === "object" && "headers" in error.cause) {
    return (error.cause as { headers: Record<string, string> }).headers;
  }
  return {};
}

/**
 * Runs `handle` (the adapter call, given the `onError` to pass it), records
 * its HTTP metrics under `metricsPath`, and returns its response with a
 * rejected request's rate-limit headers and `extraHeaders` added.
 *
 * Every response is `private, no-store`: these responses carry per-user data
 * (and change across deploys), and the CDN fronting the site caches whatever
 * its origin doesn't forbid — it once replayed a stale `auth.signupConfig` to
 * anonymous visitors.
 */
export async function serveTrpcHttp(
  req: Request,
  options: { label: string; metricsPath: string; extraHeaders?: Record<string, string> },
  handle: (onError: TrpcErrorHandler) => Promise<Response>
): Promise<Response> {
  const endTimer = startHttpTimer(req.method, options.metricsPath);
  let errorHeaders: Record<string, string> = {};

  const response = await handle(({ error, path }) => {
    if (process.env.NODE_ENV === "development") {
      console.error(`❌ ${options.label} failed on ${path ?? "<no-path>"}: ${error.message}`);
    }
    if (error.code === "TOO_MANY_REQUESTS") errorHeaders = rateLimitHeaders(error);
  });

  endTimer(response.status);

  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, no-store");
  for (const [key, value] of Object.entries({ ...errorHeaders, ...options.extraHeaders })) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
