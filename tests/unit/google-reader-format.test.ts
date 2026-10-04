/**
 * Unit tests for Google Reader wire-format helpers.
 */

import { describe, it, expect } from "vitest";
import { formatUnreadCounts } from "../../src/server/google-reader/format";
import { stateStreamId } from "../../src/server/google-reader/streams";

// Feed stream serials, as Postgres hands them back (int8 → decimal string).
const SUB_A = "42";
const SAVED_FEED = "1007";

// Distinct, fixed newest-item times so timestamp assertions are deterministic.
const NEWEST_A = new Date("2026-03-01T12:00:00.000Z");
const NEWEST_SAVED = new Date("2026-04-15T08:30:00.000Z"); // later than NEWEST_A

describe("formatUnreadCounts", () => {
  it("emits a line per subscription with unread items, and the All count as the total", () => {
    // The lines sum to 5, but one article is in both feeds' lines (a feed and
    // a collection holding it), so All — the reading-list total — is 4.
    const result = formatUnreadCounts(
      [
        { streamId: SUB_A, unreadCount: 3 },
        { streamId: SAVED_FEED, unreadCount: 2 },
      ],
      new Map([
        [SUB_A, NEWEST_A],
        [SAVED_FEED, NEWEST_SAVED],
      ]),
      4
    );

    const byId = new Map(result.unreadcounts.map((c) => [c.id, c.count]));
    expect(byId.get(`feed/${SUB_A}`)).toBe(3);
    expect(byId.get(`feed/${SAVED_FEED}`)).toBe(2);
    expect(byId.get(stateStreamId("reading-list"))).toBe(4);
  });

  it("omits subscriptions with zero unread and the total when nothing is unread", () => {
    const result = formatUnreadCounts([{ streamId: SUB_A, unreadCount: 0 }], new Map(), 0);
    expect(result.unreadcounts).toEqual([]);
  });

  it("reports the total with a current timestamp when no feed line has unread items", () => {
    // Starred articles of unsubscribed feeds count toward All but no feed line.
    const before = Date.now();
    const result = formatUnreadCounts([], new Map(), 2);
    const [total] = result.unreadcounts;
    expect(total.id).toBe(stateStreamId("reading-list"));
    expect(total.count).toBe(2);
    expect(Number(total.newestItemTimestampUsec)).toBeGreaterThanOrEqual(before * 1000);
  });

  it("reports each feed's newest visible item time, and the max across feeds for the total", () => {
    const result = formatUnreadCounts(
      [
        { streamId: SUB_A, unreadCount: 3 },
        { streamId: SAVED_FEED, unreadCount: 2 },
      ],
      new Map([
        [SUB_A, NEWEST_A],
        [SAVED_FEED, NEWEST_SAVED],
      ]),
      5
    );

    const usecById = new Map(result.unreadcounts.map((c) => [c.id, c.newestItemTimestampUsec]));
    // microseconds = ms * 1000, exact (not "now"). Regression: the synthetic
    // saved feed once derived this from an epoch `subscribedAt`, emitting a
    // literal "0" that made clients treat it as never-updated.
    expect(usecById.get(`feed/${SUB_A}`)).toBe((NEWEST_A.getTime() * 1000).toString());
    expect(usecById.get(`feed/${SAVED_FEED}`)).toBe((NEWEST_SAVED.getTime() * 1000).toString());
    // reading-list total carries the newest across all feeds.
    expect(usecById.get(stateStreamId("reading-list"))).toBe(
      (NEWEST_SAVED.getTime() * 1000).toString()
    );
  });

  it("falls back to a current, non-zero timestamp when a feed is missing from the map", () => {
    // Should-not-happen (a feed with unread items always has a visible entry), but
    // the fallback must never reintroduce the "0" bug.
    const before = Date.now();
    const result = formatUnreadCounts([{ streamId: SUB_A, unreadCount: 1 }], new Map(), 1);
    const after = Date.now();

    const line = result.unreadcounts.find((c) => c.id === `feed/${SUB_A}`);
    expect(line).toBeDefined();
    const ms = Number(line!.newestItemTimestampUsec) / 1000;
    expect(ms).toBeGreaterThanOrEqual(before);
    expect(ms).toBeLessThanOrEqual(after);
  });
});
