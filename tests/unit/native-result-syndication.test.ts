/**
 * Unit tests for the syndication-hint handling in `toFeedParseResult`.
 */

import { describe, it, expect } from "vitest";
import type { RawParsedFeed } from "@lion-reader/feed-parser";
import { toFeedParseResult } from "../../src/server/feed/streaming/native-result";
import { parseRss } from "../../src/server/feed/streaming/rss-parser";

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

  it("keeps a frequency the feed gave without any period", () => {
    const result = toFeedParseResult(rawFeed({ updateFrequency: 4 }), parseDate);

    expect(result.syndication).toEqual({ updateFrequency: 4 });
  });

  it("omits syndication entirely when the feed has no hints", () => {
    const result = toFeedParseResult(rawFeed(), parseDate);

    expect(result.syndication).toBeUndefined();
  });
});

/**
 * The guard's list has to match `VALID_UPDATE_PERIODS` in
 * `native/feed-parser/core/src/types.rs`. Going through the real parser catches
 * drift in either direction: a period Rust accepts but the guard doesn't gets
 * dropped here, and one Rust rejects never arrives.
 */
describe("update periods accepted by the native parser survive the guard", () => {
  const rssWithPeriod = (period: string) =>
    `<rss version="2.0" xmlns:sy="http://purl.org/rss/1.0/modules/syndication/">
      <channel>
        <title>Syndication Feed</title>
        <sy:updatePeriod>${period}</sy:updatePeriod>
      </channel>
    </rss>`;

  it.each(["hourly", "daily", "weekly", "monthly", "yearly"])("keeps %s", (period) => {
    expect(parseRss(rssWithPeriod(period)).syndication).toEqual({ updatePeriod: period });
  });

  it("drops a period the native parser rejects", () => {
    expect(parseRss(rssWithPeriod("fortnightly")).syndication).toBeUndefined();
  });
});
