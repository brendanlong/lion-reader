/**
 * The HTTP wrapping shared by the tRPC (`/api/trpc`) and REST (`/api/v1`)
 * route handlers, which serve the same router.
 */

import type { TRPCError } from "@trpc/server";
import { isUploadPath, MAX_UPLOAD_BODY_BYTES, MAX_UPLOAD_FILE_BYTES } from "@/lib/upload-limits";
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
 * `req` with `body` in place of its own. Built from its parts: Next's
 * `NextRequest` isn't a `Request` undici can copy.
 */
function withBody(req: Request, body: ReadableStream<Uint8Array>): Request {
  return new Request(req.url, {
    method: req.method,
    headers: req.headers,
    signal: req.signal,
    body,
    duplex: "half",
  } as RequestInit);
}

function uploadTooLarge(): TRPCError {
  return errors.contentTooLarge("The upload", MAX_UPLOAD_FILE_BYTES);
}

/**
 * `req` with a body that fails past {@link MAX_UPLOAD_BODY_BYTES}, for an
 * upload sent without a length. Uploads bypass the proxy (`isUploadPath`), so
 * nothing else bounds what they send; every other request's body is bounded
 * there.
 */
function withUploadLimit(req: Request): Request {
  if (req.body === null) return req;
  let bytes = 0;
  const body = req.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > MAX_UPLOAD_BODY_BYTES) controller.error(uploadTooLarge());
        else controller.enqueue(chunk);
      },
    })
  );
  return withBody(req, body);
}

/**
 * `req` with a body that fails with `error` when read, so the tRPC adapter
 * answers with it in its own error format.
 */
export function withFailingBody(req: Request, error: TRPCError): Request {
  const body = new ReadableStream({ start: (controller) => controller.error(error) });
  return withBody(req, body);
}

/**
 * Runs `handle` (the adapter call, given the request, an upload's with its
 * body limited, and the `onError` to pass it), or for an upload declaring a
 * body past its limit `rejectOversized`, which answers with the error in the
 * adapter's format without reading the body. Records
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
  handle: (req: Request, onError: TrpcErrorHandler) => Promise<Response>
): Promise<Response> {
  const endTimer = startHttpTimer(req.method, options.metricsPath);
  let errorHeaders: Record<string, string> = {};

  const onError: TrpcErrorHandler = ({ error, path }) => {
    if (process.env.NODE_ENV === "development") {
      console.error(`❌ ${options.label} failed on ${path ?? "<no-path>"}: ${error.message}`);
    }
    if (error.code === "TOO_MANY_REQUESTS") errorHeaders = rateLimitHeaders(error);
  };
  const isUpload = req.body !== null && isUploadPath(new URL(req.url).pathname);
  const response = !isUpload
    ? await handle(req, onError)
    : Number(req.headers.get("content-length")) > MAX_UPLOAD_BODY_BYTES
      ? await options.rejectOversized(uploadTooLarge(), onError)
      : await handle(withUploadLimit(req), onError);

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
