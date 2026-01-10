/**
 * Streaming HTTP feed fetching utilities.
 * Fetches and parses feeds using streaming to minimize memory usage.
 */

import { parseCacheHeaders, type ParsedCacheHeaders } from "./cache-headers";
import { buildUserAgent } from "../http/user-agent";
import { parseFeedStream, parseFeedStreamWithFormat } from "./streaming";
import type { ParsedFeed } from "./types";
import type { FetchFeedOptions, RedirectInfo } from "./fetcher";

/**
 * Result of a successful streaming feed fetch and parse.
 */
export interface StreamingFetchSuccessResult {
  status: "success";
  /** HTTP status code (200) */
  statusCode: 200;
  /** Parsed feed content */
  feed: ParsedFeed;
  /** Content-Type header value */
  contentType: string;
  /** Final URL after redirects */
  finalUrl: string;
  /** Parsed cache headers */
  cacheHeaders: ParsedCacheHeaders;
  /** Redirect chain if any permanent redirects occurred */
  redirects: RedirectInfo[];
}

/**
 * Result of a 304 Not Modified response.
 */
export interface StreamingFetchNotModifiedResult {
  status: "not_modified";
  /** HTTP status code (304) */
  statusCode: 304;
  /** Parsed cache headers */
  cacheHeaders: ParsedCacheHeaders;
  /** Redirect chain if any permanent redirects occurred */
  redirects: RedirectInfo[];
}

/**
 * Result of a client error (4xx).
 */
export interface StreamingFetchClientErrorResult {
  status: "client_error";
  /** HTTP status code (4xx) */
  statusCode: number;
  /** Error message */
  message: string;
  /** Whether the error is permanent (404, 410) */
  permanent: boolean;
}

/**
 * Result of a server error (5xx).
 */
export interface StreamingFetchServerErrorResult {
  status: "server_error";
  /** HTTP status code (5xx) */
  statusCode: number;
  /** Error message */
  message: string;
  /** Retry-After header value in seconds, if present */
  retryAfter?: number;
}

/**
 * Result of a rate limit (429).
 */
export interface StreamingFetchRateLimitedResult {
  status: "rate_limited";
  /** HTTP status code (429) */
  statusCode: 429;
  /** Retry-After header value in seconds, if present */
  retryAfter?: number;
}

/**
 * Result of a network or timeout error.
 */
export interface StreamingFetchNetworkErrorResult {
  status: "network_error";
  /** Error message */
  message: string;
  /** Whether this was a timeout */
  timeout: boolean;
}

/**
 * Result of a parse error.
 */
export interface StreamingFetchParseErrorResult {
  status: "parse_error";
  /** Error message */
  message: string;
}

/**
 * Result of too many redirects.
 */
export interface StreamingFetchTooManyRedirectsResult {
  status: "too_many_redirects";
  /** The last URL before giving up */
  lastUrl: string;
  /** Redirect chain */
  redirects: RedirectInfo[];
}

/**
 * All possible streaming fetch results.
 */
export type StreamingFetchFeedResult =
  | StreamingFetchSuccessResult
  | StreamingFetchNotModifiedResult
  | StreamingFetchClientErrorResult
  | StreamingFetchServerErrorResult
  | StreamingFetchRateLimitedResult
  | StreamingFetchNetworkErrorResult
  | StreamingFetchParseErrorResult
  | StreamingFetchTooManyRedirectsResult;

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 30000;

/** Default maximum redirects to follow */
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Translates technical Node.js network error messages into user-friendly descriptions.
 */
function formatNetworkErrorMessage(error: Error): string {
  const message = error.message;
  const code = (error as NodeJS.ErrnoException).code;

  if (code === "ENOTFOUND" || message.includes("ENOTFOUND")) {
    const domainMatch = message.match(/ENOTFOUND\s+(\S+)/);
    const domain = domainMatch?.[1];
    return domain ? `Domain not found: ${domain}` : "Domain not found (DNS lookup failed)";
  }

  if (code === "EAI_AGAIN" || message.includes("EAI_AGAIN")) {
    return "DNS lookup timed out (temporary DNS failure)";
  }

  if (code === "ECONNREFUSED" || message.includes("ECONNREFUSED")) {
    return "Connection refused (server not accepting connections)";
  }

  if (code === "ETIMEDOUT" || message.includes("ETIMEDOUT")) {
    return "Connection timed out";
  }

  if (code === "ECONNRESET" || message.includes("ECONNRESET")) {
    return "Connection reset by server";
  }

  if (code === "EHOSTUNREACH" || message.includes("EHOSTUNREACH")) {
    return "Host unreachable";
  }

  if (code === "ENETUNREACH" || message.includes("ENETUNREACH")) {
    return "Network unreachable";
  }

  if (code === "CERT_HAS_EXPIRED" || message.includes("certificate has expired")) {
    return "SSL certificate has expired";
  }

  if (code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || message.includes("unable to verify")) {
    return "SSL certificate verification failed";
  }

  if (
    code === "DEPTH_ZERO_SELF_SIGNED_CERT" ||
    message.includes("self-signed certificate") ||
    message.includes("self signed certificate")
  ) {
    return "SSL certificate is self-signed";
  }

  if (message.includes("certificate") || message.includes("SSL") || message.includes("TLS")) {
    return `SSL/TLS error: ${message}`;
  }

  if (message.includes("socket hang up")) {
    return "Connection closed unexpectedly";
  }

  return message;
}

/**
 * Parses the Retry-After header value.
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds;
  }

  const date = new Date(header);
  if (!isNaN(date.getTime())) {
    const delayMs = date.getTime() - Date.now();
    if (delayMs > 0) {
      return Math.ceil(delayMs / 1000);
    }
    return 0;
  }

  return undefined;
}

/**
 * Determines redirect type from status code.
 */
function getRedirectType(statusCode: number): "permanent" | "temporary" {
  if (statusCode === 301 || statusCode === 308) {
    return "permanent";
  }
  return "temporary";
}

/**
 * Checks if a status code is a redirect.
 */
function isRedirect(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400 && statusCode !== 304;
}

/**
 * Detects feed format from Content-Type header.
 */
function detectFormatFromContentType(contentType: string): "rss" | "atom" | "json" | null {
  const normalized = contentType.toLowerCase().split(";")[0].trim();

  if (normalized.includes("rss") || normalized === "application/rdf+xml") {
    return "rss";
  }
  if (normalized.includes("atom")) {
    return "atom";
  }
  if (normalized.includes("json")) {
    return "json";
  }

  return null;
}

/**
 * Fetches and parses a feed from the given URL using streaming.
 * This is more memory-efficient than fetchFeed + parseFeed as it doesn't
 * require loading the entire response body into memory as a string.
 *
 * @param url - The feed URL to fetch
 * @param options - Fetch options
 * @returns The fetch result with parsed feed or error
 */
export async function fetchAndParseFeedStream(
  url: string,
  options: FetchFeedOptions = {}
): Promise<StreamingFetchFeedResult> {
  const {
    etag,
    lastModified,
    timeout = DEFAULT_TIMEOUT_MS,
    userAgent,
    maxRedirects = DEFAULT_MAX_REDIRECTS,
    feedId,
  } = options;

  // Build request headers
  const headers: Record<string, string> = {
    "User-Agent": userAgent ?? buildUserAgent(feedId ? { context: `feed:${feedId}` } : undefined),
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };

  if (etag) {
    headers["If-None-Match"] = etag;
  }

  if (lastModified) {
    headers["If-Modified-Since"] = lastModified;
  }

  const redirects: RedirectInfo[] = [];
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(currentUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "manual",
      });

      clearTimeout(timeoutId);

      // Handle redirects
      if (isRedirect(response.status)) {
        const location = response.headers.get("location");

        if (!location) {
          return {
            status: "client_error",
            statusCode: response.status,
            message: "Redirect without Location header",
            permanent: false,
          };
        }

        const redirectUrl = new URL(location, currentUrl).toString();
        const redirectType = getRedirectType(response.status);

        redirects.push({ url: redirectUrl, type: redirectType });

        if (redirectCount === maxRedirects) {
          return {
            status: "too_many_redirects",
            lastUrl: currentUrl,
            redirects,
          };
        }

        currentUrl = redirectUrl;
        continue;
      }

      // Handle 304 Not Modified
      if (response.status === 304) {
        return {
          status: "not_modified",
          statusCode: 304,
          cacheHeaders: parseCacheHeaders(response.headers),
          redirects,
        };
      }

      // Handle success (200)
      if (response.status === 200) {
        const contentType = response.headers.get("content-type") ?? "application/xml";
        const cacheHeaders = parseCacheHeaders(response.headers);

        // Get the response body as a stream
        const body = response.body;
        if (!body) {
          return {
            status: "parse_error",
            message: "Response body is empty",
          };
        }

        try {
          // Try to detect format from Content-Type
          const format = detectFormatFromContentType(contentType);
          const feed = format
            ? await parseFeedStreamWithFormat(body, format)
            : await parseFeedStream(body);

          return {
            status: "success",
            statusCode: 200,
            feed,
            contentType,
            finalUrl: currentUrl,
            cacheHeaders,
            redirects,
          };
        } catch (parseError) {
          return {
            status: "parse_error",
            message: parseError instanceof Error ? parseError.message : "Unknown parse error",
          };
        }
      }

      // Handle 429 Rate Limited
      if (response.status === 429) {
        return {
          status: "rate_limited",
          statusCode: 429,
          retryAfter: parseRetryAfter(response.headers.get("retry-after")),
        };
      }

      // Handle 4xx client errors
      if (response.status >= 400 && response.status < 500) {
        const permanent = response.status === 404 || response.status === 410;

        return {
          status: "client_error",
          statusCode: response.status,
          message: `HTTP ${response.status}: ${response.statusText || "Client Error"}`,
          permanent,
        };
      }

      // Handle 5xx server errors
      if (response.status >= 500) {
        return {
          status: "server_error",
          statusCode: response.status,
          message: `HTTP ${response.status}: ${response.statusText || "Server Error"}`,
          retryAfter: parseRetryAfter(response.headers.get("retry-after")),
        };
      }

      // Unexpected status code
      return {
        status: "client_error",
        statusCode: response.status,
        message: `Unexpected HTTP ${response.status}: ${response.statusText || "Unknown"}`,
        permanent: false,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        return {
          status: "network_error",
          message: `Request timed out after ${timeout}ms`,
          timeout: true,
        };
      }

      const message =
        error instanceof Error ? formatNetworkErrorMessage(error) : "Unknown network error";

      return {
        status: "network_error",
        message,
        timeout: false,
      };
    }
  }

  return {
    status: "too_many_redirects",
    lastUrl: currentUrl,
    redirects,
  };
}
