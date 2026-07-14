/**
 * Unit tests for the broken-feed GitHub issue URL builder.
 *
 * Pure function, no dependencies.
 */

import { describe, it, expect } from "vitest";
import { buildFeedIssueUrl, LION_READER_REPO_URL, type FeedIssueInput } from "@/lib/github-issue";

function parse(url: string): { base: string; params: URLSearchParams } {
  const [base, query] = url.split("?");
  return { base, params: new URLSearchParams(query) };
}

describe("buildFeedIssueUrl", () => {
  const feed: FeedIssueInput = {
    title: "Example Blog",
    url: "https://example.com/feed.xml",
    lastError: "HTTP 404 Not Found",
    consecutiveFailures: 3,
  };

  it("points at the repo's new-issue form", () => {
    const { base } = parse(buildFeedIssueUrl(feed));
    expect(base).toBe(`${LION_READER_REPO_URL}/issues/new`);
  });

  it("uses the feed title in the issue title", () => {
    const { params } = parse(buildFeedIssueUrl(feed));
    expect(params.get("title")).toBe("Broken feed: Example Blog");
  });

  it("includes the feed URL, failure count, and error in the body", () => {
    const { params } = parse(buildFeedIssueUrl(feed));
    const body = params.get("body") ?? "";
    expect(body).toContain("https://example.com/feed.xml");
    expect(body).toContain("3");
    expect(body).toContain("HTTP 404 Not Found");
  });

  it("applies the bug label", () => {
    const { params } = parse(buildFeedIssueUrl(feed));
    expect(params.get("labels")).toBe("bug");
  });

  it("falls back to the URL when the title is missing", () => {
    const { params } = parse(buildFeedIssueUrl({ ...feed, title: null }));
    expect(params.get("title")).toBe("Broken feed: https://example.com/feed.xml");
  });

  it("falls back to a placeholder when both title and URL are missing", () => {
    const { params } = parse(buildFeedIssueUrl({ ...feed, title: null, url: null }));
    expect(params.get("title")).toBe("Broken feed: Unknown feed");
    expect(params.get("body")).toContain("(unknown)");
  });

  it("handles a missing error message", () => {
    const { params } = parse(buildFeedIssueUrl({ ...feed, lastError: null }));
    expect(params.get("body")).toContain("(no error message recorded)");
  });

  it("treats a whitespace-only title as missing", () => {
    const { params } = parse(buildFeedIssueUrl({ ...feed, title: "   " }));
    expect(params.get("title")).toBe("Broken feed: https://example.com/feed.xml");
  });
});
