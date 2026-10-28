/**
 * The HTTP wrapping shared by the tRPC (`/api/trpc`) and REST (`/api/v1`)
 * route handlers, which serve the same router.
 */

import type { TRPCError } from "@trpc/server";
import { MAX_REQUEST_BODY_BYTES, MAX_UPLOAD_FILE_BYTES } from "@/lib/upload-limits";
import { errors } from "@/server/errors";
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
 * The error for a request declaring a body larger than the app server reads.
 * Its adapter mustn't see it: Next's proxy has passed on only the first part
 * of the body, which would fail to parse as something else.
 */
function oversizedBodyError(req: Request): TRPCError | null {
  if (req.method === "GET" || req.method === "HEAD") return null;
  const declared = Number(req.headers.get("content-length"));
  return declared > MAX_REQUEST_BODY_BYTES
    ? errors.contentTooLarge("The upload", MAX_UPLOAD_FILE_BYTES)
    : null;
}

/**
 * `req` with a body that fails with `error` when read, so the tRPC adapter
 * answers with it in its own error format.
 */
export function withFailingBody(req: Request, error: TRPCError): Request {
  const body = new ReadableStream({ start: (controller) => controller.error(error) });
  return new Request(req, { body, duplex: "half" } as RequestInit);
}

/**
 * Runs `handle` (the adapter call, given the `onError` to pass it), or for a
 * request too large to read `rejectOversized`, which answers with the error in
 * the adapter's format. Records
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
  options: {
    label: string;
    metricsPath: string;
    extraHeaders?: Record<string, string>;
    rejectOversized: (error: TRPCError, onError: TrpcErrorHandler) => Response | Promise<Response>;
  },
  handle: (onError: TrpcErrorHandler) => Promise<Response>
): Promise<Response> {
  const endTimer = startHttpTimer(req.method, options.metricsPath);
  let errorHeaders: Record<string, string> = {};

  const onError: TrpcErrorHandler = ({ error, path }) => {
    if (process.env.NODE_ENV === "development") {
      console.error(`❌ ${options.label} failed on ${path ?? "<no-path>"}: ${error.message}`);
    }
    if (error.code === "TOO_MANY_REQUESTS") errorHeaders = rateLimitHeaders(error);
  };
  const oversized = oversizedBodyError(req);
  const response = oversized
    ? await options.rejectOversized(oversized, onError)
    : await handle(onError);

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
