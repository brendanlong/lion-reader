/**
 * Unit tests for Google Reader wire-format helpers.
 */

import { describe, it, expect } from "vitest";
import { formatUnreadCounts } from "../../src/server/google-reader/format";
import { feedStreamId } from "../../src/server/google-reader/id";
import { stateStreamId } from "../../src/server/google-reader/streams";

const SUB_A = "0191a2b3-c4d5-7e6f-8a9b-0c1d2e3f4a5b";
const SAVED_FEED = "0192ffff-1111-7222-8333-444455556666";

describe("formatUnreadCounts", () => {
  it("emits a line per subscription with unread items plus a reading-list total", () => {
    const result = formatUnreadCounts([
      { id: SUB_A, unreadCount: 3 },
      { id: SAVED_FEED, unreadCount: 2 },
    ]);

    const byId = new Map(result.unreadcounts.map((c) => [c.id, c.count]));
    expect(byId.get(feedStreamId(SUB_A))).toBe(3);
    expect(byId.get(feedStreamId(SAVED_FEED))).toBe(2);
    // Saved-feed unread folds into the reading-list total.
    expect(byId.get(stateStreamId("reading-list"))).toBe(5);
  });

  it("omits subscriptions with zero unread and the total when nothing is unread", () => {
    const result = formatUnreadCounts([{ id: SUB_A, unreadCount: 0 }]);
    expect(result.unreadcounts).toEqual([]);
  });

  it("reports a current-time newestItemTimestampUsec for every line, not the epoch", () => {
    // Regression guard: the synthetic saved feed carries an epoch `subscribedAt`.
    // newestItemTimestampUsec must not be derived from it (which yielded "0" and
    // let clients treat the saved feed as never-updated); it is a freshness signal
    // and must reflect "now".
    const before = Date.now();
    const result = formatUnreadCounts([{ id: SAVED_FEED, unreadCount: 1 }]);
    const after = Date.now();

    for (const line of result.unreadcounts) {
      // Microseconds → milliseconds; every line shares the same "now" stamp.
      const ms = Math.floor(Number(line.newestItemTimestampUsec) / 1000);
      expect(ms).toBeGreaterThanOrEqual(before);
      expect(ms).toBeLessThanOrEqual(after);
    }
  });
});
