/**
 * Unit tests for frontend formatting utilities.
 *
 * These are pure functions with no dependencies - easy to test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { formatRelativeTime, getDomain } from "@/lib/format";

describe("formatRelativeTime", () => {
  beforeEach(() => {
    // Fix the current time for deterministic tests
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns "just now" for times less than 60 seconds ago', () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe("just now");

    const thirtySecondsAgo = new Date(now.getTime() - 30 * 1000);
    expect(formatRelativeTime(thirtySecondsAgo)).toBe("just now");

    const fiftyNineSecondsAgo = new Date(now.getTime() - 59 * 1000);
    expect(formatRelativeTime(fiftyNineSecondsAgo)).toBe("just now");
  });

  it("returns minutes for times 1-59 minutes ago", () => {
    const now = new Date();

    const oneMinuteAgo = new Date(now.getTime() - 60 * 1000);
    expect(formatRelativeTime(oneMinuteAgo)).toBe("1 minute ago");

    const twoMinutesAgo = new Date(now.getTime() - 2 * 60 * 1000);
    expect(formatRelativeTime(twoMinutesAgo)).toBe("2 minutes ago");

    const fiftyNineMinutesAgo = new Date(now.getTime() - 59 * 60 * 1000);
    expect(formatRelativeTime(fiftyNineMinutesAgo)).toBe("59 minutes ago");
  });

  it("returns hours for times 1-23 hours ago", () => {
    const now = new Date();

    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    expect(formatRelativeTime(oneHourAgo)).toBe("1 hour ago");

    const twoHoursAgo = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoHoursAgo)).toBe("2 hours ago");

    const twentyThreeHoursAgo = new Date(now.getTime() - 23 * 60 * 60 * 1000);
    expect(formatRelativeTime(twentyThreeHoursAgo)).toBe("23 hours ago");
  });

  it("returns days for times 1-6 days ago", () => {
    const now = new Date();

    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(oneDayAgo)).toBe("1 day ago");

    const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoDaysAgo)).toBe("2 days ago");

    const sixDaysAgo = new Date(now.getTime() - 6 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(sixDaysAgo)).toBe("6 days ago");
  });

  it("returns weeks for times 1-4 weeks ago", () => {
    const now = new Date();

    const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(oneWeekAgo)).toBe("1 week ago");

    const twoWeeksAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoWeeksAgo)).toBe("2 weeks ago");

    const fourWeeksAgo = new Date(now.getTime() - 28 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(fourWeeksAgo)).toBe("4 weeks ago");
  });

  it("returns months for times 1-11 months ago", () => {
    const now = new Date();

    const oneMonthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(oneMonthAgo)).toBe("1 month ago");

    const sixMonthsAgo = new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(sixMonthsAgo)).toBe("6 months ago");
  });

  it("returns years for times 1+ years ago", () => {
    const now = new Date();

    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(oneYearAgo)).toBe("1 year ago");

    const twoYearsAgo = new Date(now.getTime() - 2 * 365 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(twoYearsAgo)).toBe("2 years ago");
  });
});

describe("getDomain", () => {
  it("extracts hostname from valid URLs", () => {
    expect(getDomain("https://example.com/path")).toBe("example.com");
    expect(getDomain("https://www.example.com/path?query=1")).toBe("www.example.com");
    expect(getDomain("http://subdomain.example.com:8080/")).toBe("subdomain.example.com");
  });

  it("handles URLs without paths", () => {
    expect(getDomain("https://example.com")).toBe("example.com");
    expect(getDomain("https://example.com/")).toBe("example.com");
  });

  it("returns the original string for invalid URLs", () => {
    expect(getDomain("not a url")).toBe("not a url");
    expect(getDomain("example.com")).toBe("example.com");
    expect(getDomain("")).toBe("");
  });

  it("handles edge cases", () => {
    expect(getDomain("https://localhost")).toBe("localhost");
    expect(getDomain("https://127.0.0.1")).toBe("127.0.0.1");
    expect(getDomain("https://[::1]")).toBe("[::1]");
  });
});
