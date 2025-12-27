/**
 * Unit tests for cache header parsing.
 */

import { describe, it, expect } from "vitest";
import {
  parseCacheControl,
  parseCacheHeaders,
  getEffectiveMaxAge,
  type CacheControl,
} from "../../src/server/feed/cache-headers";

describe("parseCacheControl", () => {
  describe("basic directives", () => {
    it("parses max-age directive", () => {
      const result = parseCacheControl("max-age=3600");

      expect(result.maxAge).toBe(3600);
    });

    it("parses s-maxage directive", () => {
      const result = parseCacheControl("s-maxage=7200");

      expect(result.sMaxAge).toBe(7200);
    });

    it("parses no-store directive", () => {
      const result = parseCacheControl("no-store");

      expect(result.noStore).toBe(true);
    });

    it("parses no-cache directive", () => {
      const result = parseCacheControl("no-cache");

      expect(result.noCache).toBe(true);
    });

    it("parses private directive", () => {
      const result = parseCacheControl("private");

      expect(result.private).toBe(true);
    });

    it("parses public directive", () => {
      const result = parseCacheControl("public");

      expect(result.public).toBe(true);
    });

    it("parses must-revalidate directive", () => {
      const result = parseCacheControl("must-revalidate");

      expect(result.mustRevalidate).toBe(true);
    });

    it("parses immutable directive", () => {
      const result = parseCacheControl("immutable");

      expect(result.immutable).toBe(true);
    });

    it("parses stale-while-revalidate directive", () => {
      const result = parseCacheControl("stale-while-revalidate=86400");

      expect(result.staleWhileRevalidate).toBe(86400);
    });

    it("parses stale-if-error directive", () => {
      const result = parseCacheControl("stale-if-error=172800");

      expect(result.staleIfError).toBe(172800);
    });
  });

  describe("multiple directives", () => {
    it("parses multiple directives separated by commas", () => {
      const result = parseCacheControl("max-age=3600, public, must-revalidate");

      expect(result.maxAge).toBe(3600);
      expect(result.public).toBe(true);
      expect(result.mustRevalidate).toBe(true);
    });

    it("parses common CDN header", () => {
      const result = parseCacheControl("public, max-age=31536000, s-maxage=31536000, immutable");

      expect(result.public).toBe(true);
      expect(result.maxAge).toBe(31536000);
      expect(result.sMaxAge).toBe(31536000);
      expect(result.immutable).toBe(true);
    });

    it("parses no-cache response with revalidation", () => {
      const result = parseCacheControl("no-cache, must-revalidate");

      expect(result.noCache).toBe(true);
      expect(result.mustRevalidate).toBe(true);
    });

    it("parses private cache response", () => {
      const result = parseCacheControl("private, max-age=0, no-cache");

      expect(result.private).toBe(true);
      expect(result.maxAge).toBe(0);
      expect(result.noCache).toBe(true);
    });
  });

  describe("whitespace handling", () => {
    it("handles extra spaces around values", () => {
      const result = parseCacheControl("  max-age = 3600  ,  public  ");

      expect(result.maxAge).toBe(3600);
      expect(result.public).toBe(true);
    });

    it("handles no spaces between directives", () => {
      const result = parseCacheControl("max-age=3600,public,no-cache");

      expect(result.maxAge).toBe(3600);
      expect(result.public).toBe(true);
      expect(result.noCache).toBe(true);
    });

    it("handles multiple spaces", () => {
      const result = parseCacheControl("max-age=3600   ,   public");

      expect(result.maxAge).toBe(3600);
      expect(result.public).toBe(true);
    });
  });

  describe("case insensitivity", () => {
    it("handles uppercase directives", () => {
      const result = parseCacheControl("MAX-AGE=3600, PUBLIC");

      expect(result.maxAge).toBe(3600);
      expect(result.public).toBe(true);
    });

    it("handles mixed case directives", () => {
      const result = parseCacheControl("Max-Age=3600, No-Cache");

      expect(result.maxAge).toBe(3600);
      expect(result.noCache).toBe(true);
    });
  });

  describe("quoted values", () => {
    it("strips quotes from values", () => {
      const result = parseCacheControl('max-age="3600"');

      expect(result.maxAge).toBe(3600);
    });
  });

  describe("edge cases", () => {
    it("returns defaults for null input", () => {
      const result = parseCacheControl(null);

      expect(result.maxAge).toBeUndefined();
      expect(result.sMaxAge).toBeUndefined();
      expect(result.noStore).toBe(false);
      expect(result.noCache).toBe(false);
      expect(result.private).toBe(false);
      expect(result.public).toBe(false);
      expect(result.mustRevalidate).toBe(false);
      expect(result.immutable).toBe(false);
    });

    it("returns defaults for undefined input", () => {
      const result = parseCacheControl(undefined);

      expect(result.maxAge).toBeUndefined();
      expect(result.noStore).toBe(false);
    });

    it("returns defaults for empty string", () => {
      const result = parseCacheControl("");

      expect(result.maxAge).toBeUndefined();
      expect(result.noStore).toBe(false);
    });

    it("handles negative max-age (ignores it)", () => {
      const result = parseCacheControl("max-age=-100");

      expect(result.maxAge).toBeUndefined();
    });

    it("handles non-numeric max-age (ignores it)", () => {
      const result = parseCacheControl("max-age=abc");

      expect(result.maxAge).toBeUndefined();
    });

    it("handles zero max-age", () => {
      const result = parseCacheControl("max-age=0");

      expect(result.maxAge).toBe(0);
    });

    it("ignores unknown directives", () => {
      const result = parseCacheControl("max-age=3600, unknown-directive, public");

      expect(result.maxAge).toBe(3600);
      expect(result.public).toBe(true);
    });

    it("handles empty directive (trailing comma)", () => {
      const result = parseCacheControl("max-age=3600,");

      expect(result.maxAge).toBe(3600);
    });

    it("handles only spaces and commas", () => {
      const result = parseCacheControl("  ,  ,  ");

      expect(result.maxAge).toBeUndefined();
      expect(result.noStore).toBe(false);
    });
  });

  describe("real-world examples", () => {
    it("parses typical blog feed header", () => {
      const result = parseCacheControl("public, max-age=900");

      expect(result.public).toBe(true);
      expect(result.maxAge).toBe(900); // 15 minutes
    });

    it("parses Cloudflare CDN header", () => {
      const result = parseCacheControl(
        "public, max-age=14400, s-maxage=14400, stale-while-revalidate=86400"
      );

      expect(result.public).toBe(true);
      expect(result.maxAge).toBe(14400);
      expect(result.sMaxAge).toBe(14400);
      expect(result.staleWhileRevalidate).toBe(86400);
    });

    it("parses no-cache API response", () => {
      const result = parseCacheControl("private, no-cache, no-store, must-revalidate");

      expect(result.private).toBe(true);
      expect(result.noCache).toBe(true);
      expect(result.noStore).toBe(true);
      expect(result.mustRevalidate).toBe(true);
    });

    it("parses GitHub raw content header", () => {
      const result = parseCacheControl("max-age=300");

      expect(result.maxAge).toBe(300); // 5 minutes
    });
  });
});

describe("parseCacheHeaders", () => {
  it("parses all cache-related headers", () => {
    const headers = new Headers({
      ETag: '"abc123"',
      "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT",
      "Cache-Control": "max-age=3600, public",
    });

    const result = parseCacheHeaders(headers);

    expect(result.etag).toBe('"abc123"');
    expect(result.lastModified).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
    expect(result.cacheControl.maxAge).toBe(3600);
    expect(result.cacheControl.public).toBe(true);
  });

  it("handles missing ETag", () => {
    const headers = new Headers({
      "Last-Modified": "Wed, 21 Oct 2015 07:28:00 GMT",
      "Cache-Control": "max-age=3600",
    });

    const result = parseCacheHeaders(headers);

    expect(result.etag).toBeUndefined();
    expect(result.lastModified).toBe("Wed, 21 Oct 2015 07:28:00 GMT");
  });

  it("handles missing Last-Modified", () => {
    const headers = new Headers({
      ETag: '"abc123"',
      "Cache-Control": "max-age=3600",
    });

    const result = parseCacheHeaders(headers);

    expect(result.etag).toBe('"abc123"');
    expect(result.lastModified).toBeUndefined();
  });

  it("handles missing Cache-Control", () => {
    const headers = new Headers({
      ETag: '"abc123"',
    });

    const result = parseCacheHeaders(headers);

    expect(result.etag).toBe('"abc123"');
    expect(result.cacheControl.maxAge).toBeUndefined();
    expect(result.cacheControl.noStore).toBe(false);
  });

  it("handles empty headers", () => {
    const headers = new Headers();

    const result = parseCacheHeaders(headers);

    expect(result.etag).toBeUndefined();
    expect(result.lastModified).toBeUndefined();
    expect(result.cacheControl.maxAge).toBeUndefined();
  });

  it("preserves weak ETag format", () => {
    const headers = new Headers({
      ETag: 'W/"abc123"',
    });

    const result = parseCacheHeaders(headers);

    expect(result.etag).toBe('W/"abc123"');
  });
});

describe("getEffectiveMaxAge", () => {
  it("returns undefined for no-store", () => {
    const cacheControl: CacheControl = {
      noStore: true,
      noCache: false,
      private: false,
      public: false,
      mustRevalidate: false,
      immutable: false,
      maxAge: 3600,
    };

    expect(getEffectiveMaxAge(cacheControl)).toBeUndefined();
  });

  it("returns s-maxage over max-age when both present", () => {
    const cacheControl: CacheControl = {
      noStore: false,
      noCache: false,
      private: false,
      public: true,
      mustRevalidate: false,
      immutable: false,
      maxAge: 3600,
      sMaxAge: 7200,
    };

    expect(getEffectiveMaxAge(cacheControl)).toBe(7200);
  });

  it("returns max-age when s-maxage is not present", () => {
    const cacheControl: CacheControl = {
      noStore: false,
      noCache: false,
      private: false,
      public: true,
      mustRevalidate: false,
      immutable: false,
      maxAge: 3600,
    };

    expect(getEffectiveMaxAge(cacheControl)).toBe(3600);
  });

  it("returns undefined when neither max-age nor s-maxage present", () => {
    const cacheControl: CacheControl = {
      noStore: false,
      noCache: false,
      private: false,
      public: true,
      mustRevalidate: false,
      immutable: false,
    };

    expect(getEffectiveMaxAge(cacheControl)).toBeUndefined();
  });

  it("returns 0 for max-age=0", () => {
    const cacheControl: CacheControl = {
      noStore: false,
      noCache: false,
      private: false,
      public: false,
      mustRevalidate: false,
      immutable: false,
      maxAge: 0,
    };

    expect(getEffectiveMaxAge(cacheControl)).toBe(0);
  });

  it("returns s-maxage=0 when set", () => {
    const cacheControl: CacheControl = {
      noStore: false,
      noCache: false,
      private: false,
      public: true,
      mustRevalidate: false,
      immutable: false,
      maxAge: 3600,
      sMaxAge: 0,
    };

    expect(getEffectiveMaxAge(cacheControl)).toBe(0);
  });
});
