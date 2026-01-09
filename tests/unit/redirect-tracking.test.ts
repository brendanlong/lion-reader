/**
 * Unit tests for redirect tracking helper functions.
 */

import { describe, it, expect } from "vitest";
import {
  findPermanentRedirectUrl,
  isHttpToHttpsUpgrade,
  REDIRECT_WAIT_PERIOD_MS,
} from "../../src/server/jobs/handlers";
import type { RedirectInfo } from "../../src/server/feed/fetcher";

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

  it("returns the final permanent redirect URL from a chain", () => {
    const redirects: RedirectInfo[] = [
      { url: "https://site1.com/feed.xml", type: "permanent" },
      { url: "https://site2.com/feed.xml", type: "temporary" },
      { url: "https://final.com/feed.xml", type: "permanent" },
    ];
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBe("https://final.com/feed.xml");
  });

  it("returns null if permanent redirect leads back to original URL", () => {
    const redirects: RedirectInfo[] = [{ url: "https://example.com/feed.xml", type: "permanent" }];
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBeNull();
  });

  it("handles mixed redirect chain with permanent at the end", () => {
    const redirects: RedirectInfo[] = [
      { url: "https://temp1.com/feed", type: "temporary" },
      { url: "https://temp2.com/feed", type: "temporary" },
      { url: "https://permanent.com/feed", type: "permanent" },
    ];
    const result = findPermanentRedirectUrl(redirects, "https://example.com/feed.xml");
    expect(result).toBe("https://permanent.com/feed");
  });

  it("ignores temporary redirects after permanent ones", () => {
    const redirects: RedirectInfo[] = [
      { url: "https://permanent.com/feed", type: "permanent" },
      { url: "https://temp.com/feed", type: "temporary" },
    ];
    // The function finds all permanent redirects and returns the last one
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

describe("REDIRECT_WAIT_PERIOD_MS", () => {
  it("equals 7 days in milliseconds", () => {
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(REDIRECT_WAIT_PERIOD_MS).toBe(sevenDaysMs);
  });
});
