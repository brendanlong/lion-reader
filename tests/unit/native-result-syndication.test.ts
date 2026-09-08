/**
 * Unit tests for the syndication-hint handling in `toFeedParseResult`.
 */

import { describe, it, expect } from "vitest";
import type { RawParsedFeed } from "@lion-reader/feed-parser";
import { toFeedParseResult } from "../../src/server/feed/streaming/native-result";

const parseDate = (value: string): Date | undefined => {
  const date = new Date(value);
  return isNaN(date.getTime()) ? undefined : date;
};

function rawFeed(overrides: Partial<RawParsedFeed> = {}): RawParsedFeed {
  return { entries: [], ...overrides };
}

describe("toFeedParseResult syndication hints", () => {
  it("keeps a recognized update period", () => {
    const result = toFeedParseResult(
      rawFeed({ updatePeriod: "daily", updateFrequency: 2 }),
      parseDate
    );

    expect(result.syndication).toEqual({ updatePeriod: "daily", updateFrequency: 2 });
  });

  it("drops an unrecognized update period rather than trusting the native string", () => {
    const result = toFeedParseResult(rawFeed({ updatePeriod: "fortnightly" }), parseDate);

    expect(result.syndication).toBeUndefined();
  });

  it("keeps the frequency when only the period is unrecognized", () => {
    const result = toFeedParseResult(
      rawFeed({ updatePeriod: "fortnightly", updateFrequency: 3 }),
      parseDate
    );

    expect(result.syndication).toEqual({ updateFrequency: 3 });
  });

  it("is case-sensitive, matching the lowercased values the native parser emits", () => {
    const result = toFeedParseResult(rawFeed({ updatePeriod: "Daily" }), parseDate);

    expect(result.syndication).toBeUndefined();
  });

  it("omits syndication entirely when the feed has no hints", () => {
    const result = toFeedParseResult(rawFeed(), parseDate);

    expect(result.syndication).toBeUndefined();
  });
});
