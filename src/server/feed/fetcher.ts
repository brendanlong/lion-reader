/**
 * HTTP feed fetching utilities.
 * Handles conditional GET requests, redirects, and error handling.
 */

import { fetcherConfig } from "../config/env";
import { parseCacheHeaders, type ParsedCacheHeaders } from "./cache-headers";

/**
 * Options for fetching a feed.
 */
export interface FetchFeedOptions {
  /** ETag from previous response for conditional GET */
  etag?: string;
  /** Last-Modified value from previous response for conditional GET */
  lastModified?: string;
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number;
  /** User-Agent header to send (overrides default) */
  userAgent?: string;
  /** Maximum number of redirects to follow (default: 5) */
  maxRedirects?: number;
  /** Feed ID for debugging (included in User-Agent) */
  feedId?: string;
}

/**
 * Redirect information from an HTTP response.
 */
export interface RedirectInfo {
  /** The URL we were redirected to */
  url: string;
  /** Type of redirect */
  type: "permanent" | "temporary";
}

/**
 * Result of a successful feed fetch (status 200).
 */
export interface FetchSuccessResult {
  status: "success";
  /** HTTP status code (200) */
  statusCode: 200;
  /** Response body content */
  body: string;
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
export interface FetchNotModifiedResult {
  status: "not_modified";
  /** HTTP status code (304) */
  statusCode: 304;
  /** Parsed cache headers */
  cacheHeaders: ParsedCacheHeaders;
  /** Redirect chain if any permanent redirects occurred */
  redirects: RedirectInfo[];
}

/**
 * Result of a permanent redirect (301/308) - caller should update feed URL.
 */
export interface FetchPermanentRedirectResult {
  status: "permanent_redirect";
  /** HTTP status code (301 or 308) */
  statusCode: 301 | 308;
  /** New URL to use */
  redirectUrl: string;
  /** Full redirect chain */
  redirects: RedirectInfo[];
}

/**
 * Result of a client error (4xx).
 */
export interface FetchClientErrorResult {
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
export interface FetchServerErrorResult {
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
export interface FetchRateLimitedResult {
  status: "rate_limited";
  /** HTTP status code (429) */
  statusCode: 429;
  /** Retry-After header value in seconds, if present */
  retryAfter?: number;
}

/**
 * Result of a network or timeout error.
 */
export interface FetchNetworkErrorResult {
  status: "network_error";
  /** Error message */
  message: string;
  /** Whether this was a timeout */
  timeout: boolean;
}

/**
 * Result of too many redirects.
 */
export interface FetchTooManyRedirectsResult {
  status: "too_many_redirects";
  /** The last URL before giving up */
  lastUrl: string;
  /** Redirect chain */
  redirects: RedirectInfo[];
}

/**
 * All possible fetch results.
 */
export type FetchFeedResult =
  | FetchSuccessResult
  | FetchNotModifiedResult
  | FetchPermanentRedirectResult
  | FetchClientErrorResult
  | FetchServerErrorResult
  | FetchRateLimitedResult
  | FetchNetworkErrorResult
  | FetchTooManyRedirectsResult;

/** Default request timeout in milliseconds */
const DEFAULT_TIMEOUT_MS = 30000;

/** Default maximum redirects to follow */
const DEFAULT_MAX_REDIRECTS = 5;

/**
 * Translates technical Node.js network error messages into user-friendly descriptions.
 *
 * @param error - The error object from a failed fetch
 * @returns A user-friendly error message
 */
export function formatNetworkErrorMessage(error: Error): string {
  const message = error.message;
  const code = (error as NodeJS.ErrnoException).code;

  // DNS resolution errors
  if (code === "ENOTFOUND" || message.includes("ENOTFOUND")) {
    // Extract domain from messages like "getaddrinfo ENOTFOUND example.com"
    const domainMatch = message.match(/ENOTFOUND\s+(\S+)/);
    const domain = domainMatch?.[1];
    return domain ? `Domain not found: ${domain}` : "Domain not found (DNS lookup failed)";
  }

  // DNS temporary failure (e.g., DNS server not responding)
  if (code === "EAI_AGAIN" || message.includes("EAI_AGAIN")) {
    return "DNS lookup timed out (temporary DNS failure)";
  }

  // Connection refused (server not accepting connections)
  if (code === "ECONNREFUSED" || message.includes("ECONNREFUSED")) {
    return "Connection refused (server not accepting connections)";
  }

  // Connection timed out
  if (code === "ETIMEDOUT" || message.includes("ETIMEDOUT")) {
    return "Connection timed out";
  }

  // Connection reset
  if (code === "ECONNRESET" || message.includes("ECONNRESET")) {
    return "Connection reset by server";
  }

  // Host unreachable
  if (code === "EHOSTUNREACH" || message.includes("EHOSTUNREACH")) {
    return "Host unreachable";
  }

  // Network unreachable
  if (code === "ENETUNREACH" || message.includes("ENETUNREACH")) {
    return "Network unreachable";
  }

  // SSL/TLS certificate errors
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

  // Socket hang up
  if (message.includes("socket hang up")) {
    return "Connection closed unexpectedly";
  }

  // Return original message for unrecognized errors
  return message;
}

const GITHUB_URL = "https://github.com/brendanlong/lion-reader";

/**
 * Build the User-Agent string with optional metadata.
 *
 * Format: LionReader/1.0-COMMIT feed:ID (+APP_URL; GITHUB_URL; EMAIL)
 * - COMMIT: Git commit SHA if available
 * - ID: Feed ID for debugging
 * - APP_URL: NEXT_PUBLIC_APP_URL with + prefix (primary contact)
 * - GITHUB_URL: Always included for reference
 * - EMAIL: Contact email if configured
 */
function buildUserAgent(feedId?: string): string {
  // Version with optional commit hash
  let ua = "LionReader/1.0";
  if (fetcherConfig.commitSha) {
    ua += `-${fetcherConfig.commitSha}`;
  }

  // Feed ID for debugging
  if (feedId) {
    ua += ` feed:${feedId}`;
  }

  // Build comment section with URLs and contact info
  const parts: string[] = [];

  if (fetcherConfig.appUrl) {
    // App URL gets the + prefix as primary contact point
    parts.push(`+${fetcherConfig.appUrl}`);
  }

  // Always include GitHub URL
  parts.push(GITHUB_URL);

  if (fetcherConfig.contactEmail) {
    parts.push(fetcherConfig.contactEmail);
  }

  ua += ` (${parts.join("; ")})`;

  return ua;
}

/**
 * Parses the Retry-After header value.
 *
 * @param header - The Retry-After header value
 * @returns Retry delay in seconds, or undefined if invalid
 */
function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined;

  // Try parsing as integer (seconds)
  const seconds = parseInt(header, 10);
  if (!isNaN(seconds) && seconds >= 0) {
    return seconds;
  }

  // Try parsing as HTTP date
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
  // 301 Moved Permanently, 308 Permanent Redirect
  if (statusCode === 301 || statusCode === 308) {
    return "permanent";
  }
  // 302 Found, 303 See Other, 307 Temporary Redirect
  return "temporary";
}

/**
 * Checks if a status code is a redirect.
 */
function isRedirect(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400 && statusCode !== 304;
}

/**
 * Fetches a feed from the given URL with proper HTTP headers.
 *
 * Supports:
 * - Conditional GET with If-None-Match (ETag) and If-Modified-Since
 * - Proper handling of redirects (permanent vs temporary)
 * - Timeout handling
 * - All HTTP error status codes
 *
 * @param url - The feed URL to fetch
 * @param options - Fetch options
 * @returns The fetch result with status and relevant data
 *
 * @example
 * // Initial fetch
 * const result = await fetchFeed("https://example.com/feed.xml");
 *
 * // Conditional fetch
 * const result = await fetchFeed("https://example.com/feed.xml", {
 *   etag: '"abc123"',
 *   lastModified: "Wed, 21 Oct 2015 07:28:00 GMT"
 * });
 */
export async function fetchFeed(
  url: string,
  options: FetchFeedOptions = {}
): Promise<FetchFeedResult> {
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
    "User-Agent": userAgent ?? buildUserAgent(feedId),
    Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
  };

  if (etag) {
    headers["If-None-Match"] = etag;
  }

  if (lastModified) {
    headers["If-Modified-Since"] = lastModified;
  }

  // Track redirects manually (fetch's redirect: "manual" doesn't follow redirects)
  const redirects: RedirectInfo[] = [];
  let currentUrl = url;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount++) {
    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);

    try {
      const response = await fetch(currentUrl, {
        method: "GET",
        headers,
        signal: controller.signal,
        redirect: "manual", // Handle redirects manually to track permanent ones
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

        // Resolve relative URLs
        const redirectUrl = new URL(location, currentUrl).toString();
        const redirectType = getRedirectType(response.status);

        redirects.push({ url: redirectUrl, type: redirectType });

        // If we've hit max redirects on the next iteration, we'll return too_many_redirects
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
        const body = await response.text();
        const contentType = response.headers.get("content-type") ?? "application/xml";

        return {
          status: "success",
          statusCode: 200,
          body,
          contentType,
          finalUrl: currentUrl,
          cacheHeaders: parseCacheHeaders(response.headers),
          redirects,
        };
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
        // 404 Not Found and 410 Gone are permanent errors
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

      // Unexpected status code - treat as client error
      return {
        status: "client_error",
        statusCode: response.status,
        message: `Unexpected HTTP ${response.status}: ${response.statusText || "Unknown"}`,
        permanent: false,
      };
    } catch (error) {
      clearTimeout(timeoutId);

      // Handle abort (timeout)
      if (error instanceof Error && error.name === "AbortError") {
        return {
          status: "network_error",
          message: `Request timed out after ${timeout}ms`,
          timeout: true,
        };
      }

      // Handle other network errors
      const message =
        error instanceof Error ? formatNetworkErrorMessage(error) : "Unknown network error";

      return {
        status: "network_error",
        message,
        timeout: false,
      };
    }
  }

  // This shouldn't be reached, but TypeScript needs it
  return {
    status: "too_many_redirects",
    lastUrl: currentUrl,
    redirects,
  };
}

/**
 * Check if a fetch result indicates the feed should be retried later.
 */
export function shouldRetry(result: FetchFeedResult): boolean {
  switch (result.status) {
    case "server_error":
    case "rate_limited":
    case "network_error":
      return true;
    case "client_error":
      // Don't retry permanent client errors
      return !result.permanent;
    default:
      return false;
  }
}

/**
 * Get suggested retry delay in seconds for a failed fetch.
 */
export function getRetryDelay(result: FetchFeedResult, attempt: number): number {
  // If we have a Retry-After header, use it (with bounds)
  if (result.status === "rate_limited" || result.status === "server_error") {
    if (result.retryAfter !== undefined) {
      // Bound between 1 second and 1 hour
      return Math.max(1, Math.min(3600, result.retryAfter));
    }
  }

  // Exponential backoff: 30s, 60s, 120s, 240s, 480s (capped at 8 minutes)
  const baseDelay = 30;
  const maxDelay = 480;
  return Math.min(maxDelay, baseDelay * Math.pow(2, attempt));
}
