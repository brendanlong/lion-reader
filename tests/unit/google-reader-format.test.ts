/**
 * Unit tests for Google Reader wire-format helpers.
 */

import { describe, it, expect } from "vitest";
import { formatUnreadCounts } from "../../src/server/google-reader/format";
import { feedStreamId } from "../../src/server/google-reader/id";
import { stateStreamId } from "../../src/server/google-reader/streams";

const SUB_A = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
const SAVED_FEED = "0192ffff-1111-7222-8333-444455556666";

// Distinct, fixed newest-item times so timestamp assertions are deterministic.
const NEWEST_A = new Date("2026-03-01T12:00:00.000Z");
const NEWEST_SAVED = new Date("2026-04-15T08:30:00.000Z"); // later than NEWEST_A

describe("formatUnreadCounts", () => {
  it("emits a line per subscription with unread items plus a reading-list total", () => {
    const result = formatUnreadCounts(
      [
        { id: SUB_A, unreadCount: 3 },
        { id: SAVED_FEED, unreadCount: 2 },
      ],
      new Map([
        [SUB_A, NEWEST_A],
        [SAVED_FEED, NEWEST_SAVED],
      ])
    );

    const byId = new Map(result.unreadcounts.map((c) => [c.id, c.count]));
    expect(byId.get(feedStreamId(SUB_A))).toBe(3);
    expect(byId.get(feedStreamId(SAVED_FEED))).toBe(2);
    // Saved-feed unread folds into the reading-list total.
    expect(byId.get(stateStreamId("reading-list"))).toBe(5);
  });

  it("omits subscriptions with zero unread and the total when nothing is unread", () => {
    const result = formatUnreadCounts([{ id: SUB_A, unreadCount: 0 }], new Map());
    expect(result.unreadcounts).toEqual([]);
  });

  it("reports each feed's newest visible item time, and the max across feeds for the total", () => {
    const result = formatUnreadCounts(
      [
        { id: SUB_A, unreadCount: 3 },
        { id: SAVED_FEED, unreadCount: 2 },
      ],
      new Map([
        [SUB_A, NEWEST_A],
        [SAVED_FEED, NEWEST_SAVED],
      ])
    );

    const usecById = new Map(result.unreadcounts.map((c) => [c.id, c.newestItemTimestampUsec]));
    // microseconds = ms * 1000, exact (not "now").
    expect(usecById.get(feedStreamId(SUB_A))).toBe((NEWEST_A.getTime() * 1000).toString());
    expect(usecById.get(feedStreamId(SAVED_FEED))).toBe((NEWEST_SAVED.getTime() * 1000).toString());
    // reading-list total carries the newest across all feeds.
    expect(usecById.get(stateStreamId("reading-list"))).toBe(
      (NEWEST_SAVED.getTime() * 1000).toString()
    );
  });

  it("never emits the epoch/zero for the saved feed (regression: subscribedAt sentinel)", () => {
    // The synthetic saved feed once derived its timestamp from an epoch
    // `subscribedAt`, emitting a literal "0" that made clients treat it as
    // never-updated. With a real newest-item time it must be a recent value.
    const result = formatUnreadCounts(
      [{ id: SAVED_FEED, unreadCount: 1 }],
      new Map([[SAVED_FEED, NEWEST_SAVED]])
    );
    for (const line of result.unreadcounts) {
      expect(line.newestItemTimestampUsec).not.toBe("0");
      expect(Number(line.newestItemTimestampUsec)).toBe(NEWEST_SAVED.getTime() * 1000);
    }
  });

  it("falls back to a current, non-zero timestamp when a feed is missing from the map", () => {
    // Should-not-happen (a feed with unread items always has a visible entry), but
    // the fallback must never reintroduce the "0" bug.
    const before = Date.now();
    const result = formatUnreadCounts([{ id: SUB_A, unreadCount: 1 }], new Map());
    const after = Date.now();

    const line = result.unreadcounts.find((c) => c.id === feedStreamId(SUB_A));
    expect(line).toBeDefined();
    const ms = Number(line!.newestItemTimestampUsec) / 1000;
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});
