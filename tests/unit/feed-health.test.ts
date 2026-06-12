/**
 * Unit tests for feed fetch health evaluation.
 *
 * These verify the alerting rule "at least one feed must fetch successfully
 * every N minutes". The DB snapshot query and the monitor_feed_health job
 * wiring are covered by tests/integration/feed-health.test.ts.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateFeedFetchHealth,
  buildFeedHealthPingBody,
  type FeedFetchHealthSnapshot,
} from "../../src/server/feed/health";
import { buildPingUrl } from "../../src/server/notifications/healthchecks";

const NOW = new Date("2026-06-11T12:00:00Z");
const MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

function snapshot(overrides: Partial<FeedFetchHealthSnapshot>): FeedFetchHealthSnapshot {
  return {
    pollableFeedCount: 10,
    lastSuccessfulFetchAt: NOW,
    failingFeedCount: 0,
    sampleError: null,
    ...overrides,
  };
}

function minutesBefore(now: Date, minutes: number): Date {
  return new Date(now.getTime() - minutes * 60 * 1000);
}

describe("evaluateFeedFetchHealth", () => {
  it("is healthy with a recent successful fetch", () => {
    const result = evaluateFeedFetchHealth(
      snapshot({ lastSuccessfulFetchAt: minutesBefore(NOW, 5) }),
      NOW,
      MAX_AGE_MS
    );
    expect(result.status).toBe("healthy");
    expect(result.lastSuccessAgeMs).toBe(5 * 60 * 1000);
  });

  it("is healthy exactly at the threshold", () => {
    const result = evaluateFeedFetchHealth(
      snapshot({ lastSuccessfulFetchAt: minutesBefore(NOW, 120) }),
      NOW,
      MAX_AGE_MS
    );
    expect(result.status).toBe("healthy");
  });

  it("is unhealthy when the newest success is older than the threshold", () => {
    const result = evaluateFeedFetchHealth(
      snapshot({ lastSuccessfulFetchAt: minutesBefore(NOW, 121) }),
      NOW,
      MAX_AGE_MS
    );
    expect(result.status).toBe("unhealthy");
    expect(result.reason).toContain("121 minutes");
    expect(result.lastSuccessAgeMs).toBe(121 * 60 * 1000);
  });

  it("is unhealthy when pollable feeds exist but none has ever succeeded", () => {
    const result = evaluateFeedFetchHealth(
      snapshot({ lastSuccessfulFetchAt: null, pollableFeedCount: 3 }),
      NOW,
      MAX_AGE_MS
    );
    expect(result.status).toBe("unhealthy");
    expect(result.lastSuccessAgeMs).toBeNull();
  });

  it("is healthy when there are no pollable feeds", () => {
    const result = evaluateFeedFetchHealth(
      snapshot({ pollableFeedCount: 0, lastSuccessfulFetchAt: null }),
      NOW,
      MAX_AGE_MS
    );
    expect(result.status).toBe("healthy");
  });

  it("ignores failing-feed count as long as something succeeds (partial outages are not global)", () => {
    const result = evaluateFeedFetchHealth(
      snapshot({ lastSuccessfulFetchAt: minutesBefore(NOW, 10), failingFeedCount: 9 }),
      NOW,
      MAX_AGE_MS
    );
    expect(result.status).toBe("healthy");
  });
});

describe("buildFeedHealthPingBody", () => {
  it("includes the status, reason, last success, counts, and sample error", () => {
    const snap = snapshot({
      lastSuccessfulFetchAt: new Date("2026-06-11T09:00:00Z"),
      failingFeedCount: 142,
      pollableFeedCount: 150,
      sampleError: "Unknown feed format: unable to detect RSS, Atom, or JSON Feed",
    });
    const evaluation = evaluateFeedFetchHealth(snap, NOW, MAX_AGE_MS);

    const body = buildFeedHealthPingBody(snap, evaluation);

    expect(body).toContain("Status: unhealthy");
    expect(body).toContain("Last successful fetch: 2026-06-11T09:00:00.000Z");
    expect(body).toContain("Failing feeds: 142 / 150");
    expect(body).toContain("Unknown feed format");
  });

  it("omits the error line and shows 'never' when there is no success or error", () => {
    const snap = snapshot({
      lastSuccessfulFetchAt: null,
      pollableFeedCount: 3,
      failingFeedCount: 0,
      sampleError: null,
    });
    const evaluation = evaluateFeedFetchHealth(snap, NOW, MAX_AGE_MS);

    const body = buildFeedHealthPingBody(snap, evaluation);

    expect(body).toContain("Last successful fetch: never");
    expect(body).not.toContain("Most recent feed error");
  });
});

describe("buildPingUrl", () => {
  it("returns the base URL unchanged for success", () => {
    expect(buildPingUrl("https://hc-ping.com/abc", "success")).toBe("https://hc-ping.com/abc");
  });

  it("appends the signal as a path segment", () => {
    expect(buildPingUrl("https://hc-ping.com/abc", "fail")).toBe("https://hc-ping.com/abc/fail");
    expect(buildPingUrl("https://hc-ping.com/abc", "start")).toBe("https://hc-ping.com/abc/start");
  });

  it("handles a trailing slash without doubling it", () => {
    expect(buildPingUrl("https://hc-ping.com/abc/", "fail")).toBe("https://hc-ping.com/abc/fail");
  });

  it("preserves query strings (e.g. healthchecks.io run IDs)", () => {
    expect(buildPingUrl("https://hc-ping.com/abc?rid=123", "fail")).toBe(
      "https://hc-ping.com/abc/fail?rid=123"
    );
  });
});
