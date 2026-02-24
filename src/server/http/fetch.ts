/**
 * HTTP Fetch Utilities
 *
 * Shared utilities for fetching URLs with proper error handling,
 * timeouts, and User-Agent headers.
 */

import { USER_AGENT } from "./user-agent";
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
   * Check if this error indicates the site blocked the request.
   * This includes 403 Forbidden, 429 Too Many Requests, and 406 Not Acceptable.
   */
  isBlocked(): boolean {
    return this.status === 403 || this.status === 429 || this.status === 406;
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
 * Reads a response body as a Buffer with a streaming size limit.
 * Aborts the request if the response exceeds maxBytes, preventing OOM.
 *
 * Checks Content-Length header first for an early rejection, then
 * enforces the limit while streaming chunks.
 *
 * @param response - The fetch Response object
 * @param maxBytes - Maximum allowed response size in bytes
 * @param url - The URL being fetched (for error messages)
 * @returns The response body as a Buffer
 * @throws ContentTooLargeError if the response exceeds the limit
 */
export async function readResponseBufferWithSizeLimit(
  response: Response,
  maxBytes: number,
  url: string
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

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    receivedBytes += value.byteLength;
    if (receivedBytes > maxBytes) {
      reader.cancel();
      throw new ContentTooLargeError(url, maxBytes, receivedBytes);
    }

    chunks.push(value);
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
async function readResponseWithSizeLimit(
  response: Response,
  maxBytes: number,
  url: string
): Promise<string> {
  const buffer = await readResponseBufferWithSizeLimit(response, maxBytes, url);
  return buffer.toString();
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
 * Prefers Markdown (text/markdown) but also accepts HTML.
 */
const HTML_ACCEPT_HEADER =
  "text/markdown,text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": userAgent,
        Accept: accept,
        "Accept-Encoding": ACCEPT_ENCODING,
      },
      signal: controller.signal,
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
    if (error instanceof Error && error.name === "AbortError") {
      throw errors.feedFetchError(url, "Request timed out");
    }
    if (error instanceof Error && "code" in error) {
      // This is already a TRPCError
      throw error;
    }
    throw errors.feedFetchError(url, error instanceof Error ? error.message : "Unknown error");
  } finally {
    clearTimeout(timeoutId);
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
 * Uses a longer timeout (30s) and HTML Accept header.
 * Prefers Markdown if available, but accepts HTML.
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
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PAGE_FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
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
      throw new Error(`Invalid content type: ${contentType}`);
    }

    const content = await readResponseWithSizeLimit(response, maxSizeBytes, url);
    return { content, isMarkdown, finalUrl: response.url };
  } finally {
    clearTimeout(timeout);
  }
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
