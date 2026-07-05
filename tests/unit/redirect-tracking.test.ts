/**
 * Unit tests for redirect tracking helper functions.
 */

import { describe, it, expect } from "vitest";
import { findPermanentRedirectUrl, isHttpToHttpsUpgrade } from "@/server/feed/redirect-utils";
import type { RedirectInfo } from "@/server/feed/fetcher";

describe("findPermanentRedirectUrl", () => {
  it("returns null when there are no redirects", () => {
    const result = findPermanentRedirectUrl([], "https://example.com/feed.xml");
    expect(result).toBeNull();
  });

  it("returns null when there are only temporary redirects", () => {
    const redirects: RedirectInfo[] = [
      { url: "https://example.com/temp1", type: "temporary" },
      { url: "https://example.com/temp2", type: "temporary" },
    ];
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBeNull();
  });

  it("returns the permanent redirect URL when present", () => {
    const redirects: RedirectInfo[] = [{ url: "https://newsite.com/feed.xml", type: "permanent" }];
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBe("https://newsite.com/feed.xml");
  });

  it("follows a run of permanent hops from the start", () => {
    const redirects: RedirectInfo[] = [
      { url: "https://site1.com/feed.xml", type: "permanent" },
      { url: "https://site2.com/feed.xml", type: "permanent" },
      { url: "https://final.com/feed.xml", type: "permanent" },
    ];
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBe("https://final.com/feed.xml");
  });

  it("stops at the first temporary hop, ignoring later permanent hops", () => {
    // 301 A→site1, 302 site1→site2, 301 site2→final.
    // A permanently moved to site1, but site1→final is only reachable via a
    // temporary hop, so we must migrate to site1, not final.
    const redirects: RedirectInfo[] = [
      { url: "https://site1.com/feed.xml", type: "permanent" },
      { url: "https://site2.com/feed.xml", type: "temporary" },
      { url: "https://final.com/feed.xml", type: "permanent" },
    ];
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBe("https://site1.com/feed.xml");
  });

  it("returns null if permanent redirect leads back to original URL", () => {
    const redirects: RedirectInfo[] = [{ url: "https://example.com/feed.xml", type: "permanent" }];
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBeNull();
  });

  it("returns null when the chain starts with a temporary hop", () => {
    // The original URL never permanently moved (its first hop is temporary), so
    // a later permanent hop must not trigger a migration.
    const redirects: RedirectInfo[] = [
      { url: "https://temp1.com/feed", type: "temporary" },
      { url: "https://temp2.com/feed", type: "temporary" },
      { url: "https://permanent.com/feed", type: "permanent" },
    ];
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBeNull();
  });

  it("ignores temporary redirects after a leading permanent one", () => {
    const redirects: RedirectInfo[] = [
      { url: "https://permanent.com/feed", type: "permanent" },
      { url: "https://temp.com/feed", type: "temporary" },
    ];
    // Follows the leading permanent hop, then stops at the temporary one.
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBe("https://permanent.com/feed");
  });
});

describe("isHttpToHttpsUpgrade", () => {
  it("returns true for http to https upgrade with same URL", () => {
    expect(
      isHttpToHttpsUpgrade("http://example.com/feed.xml", "https://example.com/feed.xml")
    ).toBe(true);
  });

  it("returns true for http to https upgrade with path", () => {
    expect(
      isHttpToHttpsUpgrade(
        "http://example.com/path/to/feed.xml",
        "https://example.com/path/to/feed.xml"
      )
    ).toBe(true);
  });

  it("returns true for http to https upgrade with query params", () => {
    expect(
      isHttpToHttpsUpgrade(
        "http://example.com/feed.xml?format=rss",
        "https://example.com/feed.xml?format=rss"
      )
    ).toBe(true);
  });

  it("returns false for https to http (downgrade)", () => {
    expect(
      isHttpToHttpsUpgrade("https://example.com/feed.xml", "http://example.com/feed.xml")
    ).toBe(false);
  });

  it("returns false when already https", () => {
    expect(
      isHttpToHttpsUpgrade("https://example.com/feed.xml", "https://example.com/feed.xml")
    ).toBe(false);
  });

  it("returns false when host differs", () => {
    expect(isHttpToHttpsUpgrade("http://example.com/feed.xml", "https://other.com/feed.xml")).toBe(
      false
    );
  });

  it("returns false when path differs", () => {
    expect(isHttpToHttpsUpgrade("http://example.com/old.xml", "https://example.com/new.xml")).toBe(
      false
    );
  });

  it("returns false when query params differ", () => {
    expect(
      isHttpToHttpsUpgrade("http://example.com/feed.xml?v=1", "https://example.com/feed.xml?v=2")
    ).toBe(false);
  });

  it("returns false for invalid URLs", () => {
    expect(isHttpToHttpsUpgrade("not-a-url", "https://example.com/feed.xml")).toBe(false);
    expect(isHttpToHttpsUpgrade("http://example.com/feed.xml", "not-a-url")).toBe(false);
    expect(isHttpToHttpsUpgrade("not-a-url", "also-not-a-url")).toBe(false);
  });

  it("handles URLs with ports", () => {
    expect(
      isHttpToHttpsUpgrade("http://example.com:8080/feed.xml", "https://example.com:8080/feed.xml")
    ).toBe(true);

    expect(
      isHttpToHttpsUpgrade("http://example.com:8080/feed.xml", "https://example.com:8443/feed.xml")
    ).toBe(false);
  });

  it("handles URLs with subdomains", () => {
    expect(
      isHttpToHttpsUpgrade("http://www.example.com/feed.xml", "https://www.example.com/feed.xml")
    ).toBe(true);

    expect(
      isHttpToHttpsUpgrade("http://www.example.com/feed.xml", "https://example.com/feed.xml")
    ).toBe(false);
  });
});
