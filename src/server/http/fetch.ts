/**
 * HTTP Fetch Utilities
 *
 * Shared utilities for fetching URLs with proper error handling,
 * timeouts, and User-Agent headers.
 */

import { USER_AGENT } from "./user-agent";
import { fetchWithSsrfProtection } from "./ssrf";
import { errors } from "../trpc/errors";
import { usageLimitsConfig } from "../config/env";

// ============================================================================
// Custom Errors
// ============================================================================

/**
 * Error thrown when an HTTP request fails.
 * Includes the HTTP status code for better error handling.
 */
export class HttpFetchError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly url: string
  ) {
    super(`HTTP ${status}: ${statusText}`);
    this.name = "HttpFetchError";
  }

  /**
   * Check if this error indicates the upstream server is rate limiting us.
   */
  isRateLimited(): boolean {
    return this.status === 429;
  }

  /**
   * Check if this error indicates the site blocked the request.
   * This includes 403 Forbidden, 429 Too Many Requests, and 406 Not Acceptable.
   */
  isBlocked(): boolean {
    return this.status === 403 || this.status === 429 || this.status === 406;
  }
}

/**
 * Error thrown when a page fetch returns a content type we don't treat as an
 * article (e.g. a feed served as `application/rss+xml`). Carries the offending
 * content type so callers can decide whether the URL is actually a feed and
 * route the user to Subscribe instead of failing the save.
 */
export class InvalidContentTypeError extends Error {
  constructor(
    public readonly contentType: string,
    public readonly url: string
  ) {
    super(`Invalid content type: ${contentType}`);
    this.name = "InvalidContentTypeError";
  }
}

/**
 * Error thrown when a response body exceeds the maximum allowed size.
 * Checked during streaming to avoid loading the full body into memory.
 */
export class ContentTooLargeError extends Error {
  constructor(
    public readonly url: string,
    public readonly maxBytes: number,
    public readonly receivedBytes: number
  ) {
    const maxMB = Math.round(maxBytes / (1024 * 1024));
    super(`Response body exceeds maximum size of ${maxMB}MB`);
    this.name = "ContentTooLargeError";
  }
}

/**
 * Error thrown when reading a body exceeds the allowed wall-clock time.
 * Used to bound inbound webhook reads against slow-loris connection holding.
 */
export class BodyReadTimeoutError extends Error {
  constructor(
    public readonly url: string,
    public readonly timeoutMs: number
  ) {
    super(`Body read exceeded ${timeoutMs}ms`);
    this.name = "BodyReadTimeoutError";
  }
}

/**
 * Reads a response body as a Buffer with a streaming size limit.
 * Aborts the request if the response exceeds maxBytes, preventing OOM.
 *
 * Checks Content-Length header first for an early rejection, then
 * enforces the limit while streaming chunks.
 *
 * @param response - The fetch Response object
 * @param maxBytes - Maximum allowed response size in bytes
 * @param url - The URL being fetched (for error messages)
 * @param timeoutMs - Optional wall-clock deadline for the whole read; a slow
 *   trickle that never exceeds maxBytes can otherwise hold a connection open
 *   indefinitely (slow-loris). Outbound fetches bound this with
 *   `AbortSignal.timeout` on the request itself; inbound webhook reads pass it
 *   here.
 * @returns The response body as a Buffer
 * @throws ContentTooLargeError if the response exceeds the size limit
 * @throws BodyReadTimeoutError if the read exceeds timeoutMs
 */
export async function readResponseBufferWithSizeLimit(
  response: Request | Response,
  maxBytes: number,
  url: string,
  timeoutMs?: number
): Promise<Buffer> {
  // Early check: Content-Length header (not always present, but fast rejection)
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredSize = parseInt(contentLength, 10);
    if (!isNaN(declaredSize) && declaredSize > maxBytes) {
      throw new ContentTooLargeError(url, maxBytes, declaredSize);
    }
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let receivedBytes = 0;

  // Wall-clock deadline: cancelling the reader unblocks a hung `read()` (a
  // trickling client), which then resolves `done` and lets us throw below.
  let timedOut = false;
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          timedOut = true;
          reader.cancel().catch(() => {});
        }, timeoutMs);

  try {
    while (true) {
      const { done, value } = await reader.read();
      // Check the timeout flag BEFORE `done`: a timeout calls `reader.cancel()`,
      // which resolves the pending `read()` with `done: true`, so testing `done`
      // first would silently return a partial body instead of failing. (At the
      // exact deadline this may also reject a body whose final chunk landed in
      // the same tick — acceptable, since that read did take the full timeout.)
      if (timedOut) {
        throw new BodyReadTimeoutError(url, timeoutMs!);
      }
      if (done) break;

      receivedBytes += value.byteLength;
      if (receivedBytes > maxBytes) {
        reader.cancel();
        throw new ContentTooLargeError(url, maxBytes, receivedBytes);
      }

      chunks.push(value);
    }
  } finally {
    if (timer) clearTimeout(timer);
  }

  return Buffer.concat(chunks, receivedBytes);
}

/**
 * Reads a response body as text with a streaming size limit.
 * Delegates to readResponseBufferWithSizeLimit and decodes the result.
 *
 * @param response - The fetch Response object
 * @param maxBytes - Maximum allowed response size in bytes
 * @param url - The URL being fetched (for error messages)
 * @returns The response body as a string
 * @throws ContentTooLargeError if the response exceeds the limit
 */
export async function readResponseWithSizeLimit(
  response: Response,
  maxBytes: number,
  url: string
): Promise<string> {
  const buffer = await readResponseBufferWithSizeLimit(response, maxBytes, url);
  return buffer.toString();
}

/**
 * Reads an incoming Request body as a Buffer with a streaming size limit.
 *
 * Used by webhook endpoints (e.g. WebSub content notifications) that must buffer
 * the body before authenticating it (HMAC). Enforcing the cap while streaming
 * means an oversized body is aborted before it is fully buffered, so an attacker
 * who learns a callback URL can't exhaust memory by POSTing a huge payload.
 *
 * Returns the raw bytes (not a decoded string) so the caller can verify the HMAC
 * over exactly what the hub signed — decoding to UTF-8 and re-encoding inside
 * `hmac.update` would drop a leading BOM and mangle non-round-tripping bytes,
 * shifting which bodies verify.
 *
 * Bounds the read with a wall-clock deadline (default
 * `REQUEST_BODY_READ_TIMEOUT_MS`): the size cap alone stops a *large* body, but
 * a client trickling bytes below the cap could otherwise hold the connection
 * (and its request handler) open indefinitely — a slow-loris connection-
 * exhaustion vector once a callback URL leaks.
 *
 * @throws ContentTooLargeError if the request body exceeds the size limit
 * @throws BodyReadTimeoutError if the read exceeds the timeout
 */
export async function readRequestBufferWithSizeLimit(
  request: Request,
  maxBytes: number,
  timeoutMs: number = REQUEST_BODY_READ_TIMEOUT_MS
): Promise<Buffer> {
  return readResponseBufferWithSizeLimit(request, maxBytes, request.url, timeoutMs);
}

// ============================================================================
// Constants
// ============================================================================

/**
 * Accept-Encoding header for outgoing requests.
 *
 * Node.js's native fetch only advertises "gzip, deflate" by default,
 * but it can also decompress brotli. Explicitly including "br" lets servers
 * send brotli-compressed responses, which are typically 15-20% smaller than gzip.
 *
 * zstd is included for Node.js 22+ which supports it natively.
 */
export const ACCEPT_ENCODING = "zstd, gzip, deflate, br";

/**
 * Default timeout for feed fetch requests (10 seconds).
 */
export const FEED_FETCH_TIMEOUT_MS = 10000;

/**
 * Wall-clock deadline for reading an inbound request body (30 seconds).
 * Bounds slow-loris connection holding on webhook endpoints that must buffer
 * the body before authenticating it (see `readRequestBufferWithSizeLimit`).
 */
export const REQUEST_BODY_READ_TIMEOUT_MS = 30000;

/**
 * Timeout for page fetch requests (30 seconds).
 * Used for saved articles where pages may be slower to load.
 */
const PAGE_FETCH_TIMEOUT_MS = 30000;

// ============================================================================
// Types
// ============================================================================

export interface FetchUrlResult {
  /** The response body as text */
  text: string;
  /** The Content-Type header value */
  contentType: string;
  /** The final URL after any redirects */
  finalUrl: string;
  /** Whether the content is Markdown (based on Content-Type header) */
  isMarkdown?: boolean;
}

export interface FetchUrlOptions {
  /** Timeout in milliseconds. Defaults to FEED_FETCH_TIMEOUT_MS. */
  timeoutMs?: number;
  /** Accept header value. Defaults to feed content types. */
  accept?: string;
  /** Custom User-Agent header. Defaults to USER_AGENT. */
  userAgent?: string;
  /** Maximum response size in bytes. Defaults to maxFeedSizeBytes from config. */
  maxSizeBytes?: number;
}

// ============================================================================
// Default Accept Headers
// ============================================================================

/**
 * Accept header for feed requests (RSS, Atom, XML).
 */
const FEED_ACCEPT_HEADER =
  "application/rss+xml, application/atom+xml, application/xml, text/xml, */*";

/**
 * Accept header for HTML page requests.
 *
 * We deliberately do NOT advertise a preference for `text/markdown`. Some sites
 * (Quartz/turntrout, gwern.net) honor `Accept: text/markdown` by returning a
 * whole-page markdown dump or Pandoc-flavored markdown that our GFM converter
 * mangles — leaking page chrome, dropping content, and losing article structure
 * Readability would otherwise recover (#1280). Requesting HTML like a browser
 * lets Readability do article extraction. The trailing wildcard still lets a
 * markdown-only endpoint (e.g. a raw `.md` URL) respond with markdown, which the
 * caller detects via Content-Type and converts as a fallback.
 */
const HTML_ACCEPT_HEADER = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

// ============================================================================
// Fetch Utilities
// ============================================================================

/**
 * Fetches content from a URL with proper error handling and timeout.
 *
 * @param url - The URL to fetch
 * @param options - Fetch options (timeout, accept header, user agent)
 * @returns The response with text content, content type, and final URL
 * @throws TRPCError on fetch failure
 */
export async function fetchUrl(url: string, options?: FetchUrlOptions): Promise<FetchUrlResult> {
  const timeoutMs = options?.timeoutMs ?? FEED_FETCH_TIMEOUT_MS;
  const accept = options?.accept ?? FEED_ACCEPT_HEADER;
  const userAgent = options?.userAgent ?? USER_AGENT;
  const maxSizeBytes = options?.maxSizeBytes ?? usageLimitsConfig.maxFeedSizeBytes;

  try {
    const response = await fetchWithSsrfProtection(url, {
      headers: {
        "User-Agent": userAgent,
        Accept: accept,
        "Accept-Encoding": ACCEPT_ENCODING,
      },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
    });

    if (!response.ok) {
      throw errors.feedFetchError(url, `HTTP ${response.status}`);
    }

    const text = await readResponseWithSizeLimit(response, maxSizeBytes, url);
    const contentType = response.headers.get("content-type") ?? "";
    const isMarkdown = contentType.includes("text/markdown");

    return { text, contentType, finalUrl: response.url, isMarkdown };
  } catch (error) {
    if (error instanceof ContentTooLargeError) {
      throw errors.contentTooLarge("Feed", maxSizeBytes);
    }
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw errors.feedFetchError(url, "Request timed out");
    }
    if (error instanceof Error && "code" in error) {
      // This is already a TRPCError
      throw error;
    }
    throw errors.feedFetchError(url, error instanceof Error ? error.message : "Unknown error");
  }
}

/**
 * Result from fetching an HTML page (or Markdown).
 */
export interface FetchHtmlPageResult {
  /** The content as text (HTML or Markdown) */
  content: string;
  /** Whether the content is Markdown (based on Content-Type header) */
  isMarkdown: boolean;
  /** The final URL after following redirects (use for resolving relative URLs) */
  finalUrl: string;
}

/**
 * Fetches an HTML page with appropriate settings.
 *
 * Uses a longer timeout (30s) and an HTML Accept header. Requests HTML (not
 * Markdown — see HTML_ACCEPT_HEADER / #1280), but still reports `isMarkdown`
 * when a server returns markdown anyway (e.g. a raw `.md` URL) so the caller
 * can convert it as a fallback.
 *
 * @param url - The URL to fetch
 * @returns The content and whether it's Markdown
 * @throws Error on fetch failure
 */
export async function fetchHtmlPage(
  url: string,
  options?: { maxSizeBytes?: number }
): Promise<FetchHtmlPageResult> {
  const maxSizeBytes = options?.maxSizeBytes ?? usageLimitsConfig.maxSavedArticleSizeBytes;

  const response = await fetchWithSsrfProtection(url, {
    signal: AbortSignal.timeout(PAGE_FETCH_TIMEOUT_MS),
    headers: {
      "User-Agent": USER_AGENT,
      Accept: HTML_ACCEPT_HEADER,
      "Accept-Encoding": ACCEPT_ENCODING,
    },
    redirect: "follow",
  });

  if (!response.ok) {
    throw new HttpFetchError(response.status, response.statusText, url);
  }

  const contentType = response.headers.get("content-type") || "";
  const isMarkdown = contentType.includes("text/markdown");

  // Accept markdown, HTML, or XHTML
  if (
    !isMarkdown &&
    !contentType.includes("text/html") &&
    !contentType.includes("application/xhtml+xml")
  ) {
    throw new InvalidContentTypeError(contentType, url);
  }

  const content = await readResponseWithSizeLimit(response, maxSizeBytes, url);
  return { content, isMarkdown, finalUrl: response.url };
}

// ============================================================================
// Content Detection
// ============================================================================

/**
 * Determines if content is HTML (for feed discovery) or a feed.
 *
 * Checks both the Content-Type header and the content body.
 *
 * @param contentType - The Content-Type header value
 * @param content - The content body
 * @returns true if the content is HTML
 */
export function isHtmlContent(contentType: string, content: string): boolean {
  // Check content type header
  if (contentType.includes("text/html") || contentType.includes("application/xhtml+xml")) {
    return true;
  }

  // Fallback: check content itself (only lowercase a small prefix for efficiency)
  const trimmed = content.trimStart();
  const prefix = trimmed.slice(0, 20).toLowerCase();
  return prefix.startsWith("<!doctype html") || prefix.startsWith("<html");
}
