/**
 * The HTTP wrapping shared by the tRPC (`/api/trpc`) and REST (`/api/v1`)
 * route handlers, which serve the same router.
 */

import { TRPCError } from "@trpc/server";
import { maxUploadBodyBytes, UPLOAD_PATHS } from "@/lib/upload-limits";
import { authenticateCredential, getBearerOrSessionCookie } from "@/server/auth/credential";
import { usageLimitsConfig } from "@/server/config/env";
import { errors } from "@/server/errors";
import { startHttpTimer } from "@/server/metrics/metrics";
import { TRPC_CREDENTIAL_KINDS, type TrpcCredential } from "@/server/trpc/context";
import { insufficientScopeError, unauthenticatedError, UPLOAD_SCOPES } from "@/server/trpc/trpc";

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

/**
 * `req` with a body that fails with `error` when read, so the tRPC adapter
 * answers with it in its own error format.
 */
export function withFailingBody(req: Request, error: TRPCError): Request {
  const body = new ReadableStream({ start: (controller) => controller.error(error) });
  return withBody(req, body);
}

type Reject = (error: TRPCError, onError: TrpcErrorHandler) => Response | Promise<Response>;

type Handle = (
  req: Request,
  onError: TrpcErrorHandler,
  credential?: TrpcCredential
) => Promise<Response>;

/** Why an upload's credential is refused, as the procedure would refuse it. */
function authError(reason: "unauthenticated" | "insufficient_scope" | "unconfirmed"): TRPCError {
  switch (reason) {
    case "unauthenticated":
      return unauthenticatedError();
    case "insufficient_scope":
      return insufficientScopeError(UPLOAD_SCOPES);
    case "unconfirmed":
      return errors.signupConfirmationRequired();
  }
}

/**
 * Serves an upload, which bypasses the proxy (`UPLOAD_PATHS`), so nothing
 * else bounds what it sends, and whose body the REST adapter reads whole
 * before authenticating. So it's rejected without reading its body unless
 * its credential passes the checks its procedure (`uploadProcedure`) makes
 * and it declares no
 * more than its endpoint's limit, and fails once it passes the limit if it
 * declares no length.
 */
async function serveUpload(
  req: Request,
  maxFileBytes: number,
  reject: Reject,
  handle: Handle,
  onError: TrpcErrorHandler
): Promise<Response> {
  const auth = await authenticateCredential(getBearerOrSessionCookie(req.headers), {
    accept: TRPC_CREDENTIAL_KINDS,
    requiredScopes: UPLOAD_SCOPES,
    requireConfirmed: true,
  });
  if (!auth.ok) return reject(authError(auth.reason), onError);

  const maxBodyBytes = maxUploadBodyBytes(maxFileBytes);
  const tooLarge = () => errors.contentTooLarge("The upload", maxFileBytes);
  if (Number(req.headers.get("content-length")) > maxBodyBytes) return reject(tooLarge(), onError);

  let bytes = 0;
  const body = req.body!.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        bytes += chunk.byteLength;
        if (bytes > maxBodyBytes) controller.error(tooLarge());
        else controller.enqueue(chunk);
      },
    })
  );
  const response = await handle(withBody(req, body), onError, auth.credential);
  // The REST adapter reports any failure reading the body as a parse error.
  return bytes > maxBodyBytes ? reject(tooLarge(), onError) : response;
}

/**
 * Runs `handle` (the adapter call, given the request, the `onError` to pass
 * it and, for an upload, the credential it was authenticated with), an
 * upload's through {@link serveUpload}, whose `reject` answers with an error
 * in the adapter's format without reading the body. Records
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
    reject: Reject;
  },
  handle: Handle
): Promise<Response> {
  const endTimer = startHttpTimer(req.method, options.metricsPath);
  let errorHeaders: Record<string, string> = {};

  const onError: TrpcErrorHandler = ({ error, path }) => {
    if (process.env.NODE_ENV === "development") {
      console.error(`❌ ${options.label} failed on ${path ?? "<no-path>"}: ${error.message}`);
    }
    if (error.code === "TOO_MANY_REQUESTS") errorHeaders = rateLimitHeaders(error);
  };
  const fileLimit = req.body !== null ? UPLOAD_PATHS.get(new URL(req.url).pathname) : undefined;
  const response = fileLimit
    ? await serveUpload(
        req,
        fileLimit(usageLimitsConfig.maxSavedArticleSizeBytes),
        options.reject,
        handle,
        onError
      )
    : await handle(req, onError);

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
