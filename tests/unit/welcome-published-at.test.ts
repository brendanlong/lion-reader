import { describe, expect, it } from "vitest";
import {
  resolveWelcomePublishedAt,
  WELCOME_FALLBACK_PUBLISHED_AT,
} from "@/app/demo/articles/welcome-published-at";
import { DEMO_ARTICLES } from "@/app/demo/articles";

describe("resolveWelcomePublishedAt", () => {
  it("parses a valid ISO build timestamp", () => {
    const result = resolveWelcomePublishedAt("2026-07-15T09:30:00Z");
    expect(result.toISOString()).toBe("2026-07-15T09:30:00.000Z");
  });

  it("falls back to the fixed date when build time is undefined", () => {
    const result = resolveWelcomePublishedAt(undefined);
    expect(result.toISOString()).toBe(new Date(WELCOME_FALLBACK_PUBLISHED_AT).toISOString());
  });

  it("falls back to the fixed date when build time is empty", () => {
    const result = resolveWelcomePublishedAt("");
    expect(result.toISOString()).toBe(new Date(WELCOME_FALLBACK_PUBLISHED_AT).toISOString());
  });

  it("falls back to the fixed date when build time is unparseable", () => {
    const result = resolveWelcomePublishedAt("not-a-date");
    expect(result.toISOString()).toBe(new Date(WELCOME_FALLBACK_PUBLISHED_AT).toISOString());
  });

  it("keeps the welcome article newer than every other demo article", () => {
    // Guards the pinned-to-top invariant: the fallback (and thus any real
    // deploy time, which is later still) must sort ahead of all other articles
    // in the newest-first demo list.
    const fallback = resolveWelcomePublishedAt(undefined).getTime();
    const others = DEMO_ARTICLES.filter((a) => a.id !== "welcome");
    expect(others.length).toBeGreaterThan(0);
    for (const article of others) {
      expect(article.publishedAt.getTime()).toBeLessThan(fallback);
    }
  });
});
