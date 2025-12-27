/**
 * Cache header parsing utilities.
 * Pure functions for parsing HTTP cache-related headers.
 */

/**
 * Parsed Cache-Control directives.
 */
export interface CacheControl {
  /** Maximum age in seconds (max-age directive) */
  maxAge?: number;
  /** Shared cache maximum age in seconds (s-maxage directive) */
  sMaxAge?: number;
  /** Whether the response must not be cached (no-store) */
  noStore: boolean;
  /** Whether the response must be revalidated (no-cache) */
  noCache: boolean;
  /** Whether the response is private (private) */
  private: boolean;
  /** Whether the response is public (public) */
  public: boolean;
  /** Whether revalidation is required when stale (must-revalidate) */
  mustRevalidate: boolean;
  /** Whether the response is immutable (immutable) */
  immutable: boolean;
  /** Stale-while-revalidate window in seconds */
  staleWhileRevalidate?: number;
  /** Stale-if-error window in seconds */
  staleIfError?: number;
}

/**
 * Parses a Cache-Control header value into structured directives.
 *
 * @param header - The Cache-Control header value (e.g., "max-age=3600, public")
 * @returns Parsed cache control directives
 *
 * @example
 * parseCacheControl("max-age=3600, public")
 * // => { maxAge: 3600, public: true, ... }
 *
 * @example
 * parseCacheControl("no-store, no-cache, private")
 * // => { noStore: true, noCache: true, private: true, ... }
 */
export function parseCacheControl(header: string | null | undefined): CacheControl {
  const result: CacheControl = {
    noStore: false,
    noCache: false,
    private: false,
    public: false,
    mustRevalidate: false,
    immutable: false,
  };

  if (!header) {
    return result;
  }

  // Normalize: lowercase, remove extra spaces
  const normalized = header.toLowerCase().replace(/\s+/g, " ").trim();

  // Split by comma and process each directive
  const directives = normalized.split(",").map((d) => d.trim());

  for (const directive of directives) {
    // Skip empty directives
    if (!directive) continue;

    // Check for directives with values (name=value)
    const equalsIndex = directive.indexOf("=");

    if (equalsIndex !== -1) {
      const name = directive.slice(0, equalsIndex).trim();
      const valueStr = directive.slice(equalsIndex + 1).trim();
      // Remove quotes if present
      const value = valueStr.replace(/^"(.*)"$/, "$1");
      const numValue = parseInt(value, 10);

      switch (name) {
        case "max-age":
          if (!isNaN(numValue) && numValue >= 0) {
            result.maxAge = numValue;
          }
          break;
        case "s-maxage":
          if (!isNaN(numValue) && numValue >= 0) {
            result.sMaxAge = numValue;
          }
          break;
        case "stale-while-revalidate":
          if (!isNaN(numValue) && numValue >= 0) {
            result.staleWhileRevalidate = numValue;
          }
          break;
        case "stale-if-error":
          if (!isNaN(numValue) && numValue >= 0) {
            result.staleIfError = numValue;
          }
          break;
      }
    } else {
      // Boolean directives (no value)
      switch (directive) {
        case "no-store":
          result.noStore = true;
          break;
        case "no-cache":
          result.noCache = true;
          break;
        case "private":
          result.private = true;
          break;
        case "public":
          result.public = true;
          break;
        case "must-revalidate":
          result.mustRevalidate = true;
          break;
        case "immutable":
          result.immutable = true;
          break;
      }
    }
  }

  return result;
}

/**
 * Parsed cache headers from an HTTP response.
 */
export interface ParsedCacheHeaders {
  /** ETag header value */
  etag?: string;
  /** Last-Modified header value (as string, to preserve original format) */
  lastModified?: string;
  /** Parsed Cache-Control directives */
  cacheControl: CacheControl;
}

/**
 * Parses all cache-related headers from an HTTP response.
 *
 * @param headers - The HTTP response headers
 * @returns Parsed cache headers
 */
export function parseCacheHeaders(headers: Headers): ParsedCacheHeaders {
  const etag = headers.get("etag") ?? undefined;
  const lastModified = headers.get("last-modified") ?? undefined;
  const cacheControlHeader = headers.get("cache-control");

  return {
    etag,
    lastModified,
    cacheControl: parseCacheControl(cacheControlHeader),
  };
}

/**
 * Calculates the effective max-age from cache headers.
 * Prioritizes s-maxage over max-age (for shared caches).
 *
 * @param cacheControl - Parsed cache control directives
 * @returns The effective max-age in seconds, or undefined if not cacheable
 */
export function getEffectiveMaxAge(cacheControl: CacheControl): number | undefined {
  // If no-store or no-cache, don't cache
  if (cacheControl.noStore) {
    return undefined;
  }

  // s-maxage takes precedence for shared caches
  if (cacheControl.sMaxAge !== undefined) {
    return cacheControl.sMaxAge;
  }

  // Fall back to max-age
  if (cacheControl.maxAge !== undefined) {
    return cacheControl.maxAge;
  }

  return undefined;
}
