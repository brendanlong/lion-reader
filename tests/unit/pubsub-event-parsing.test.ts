/**
 * Redis events cross a rolling deploy: an SSE server must parse what the
 * previous release publishes, and vice versa.
 */

import { describe, expect, it } from "vitest";
import { parseSiteStatusEvent, parseUserEvent } from "@/server/redis/pubsub";

const base = {
  userId: "user-1",
  timestamp: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};
const metadata = { title: "T", author: null, summary: null, url: null, publishedAt: null };

describe("parseUserEvent", () => {
  it.each([
    [
      "entry_updated with feedType",
      {
        ...base,
        type: "entry_updated",
        subscriptionId: null,
        entryId: "e",
        feedType: "saved",
        metadata,
      },
    ],
    [
      "import_progress without updatedAt",
      {
        type: "import_progress",
        userId: "user-1",
        timestamp: base.timestamp,
        importId: "i",
        feedUrl: "https://example.com/feed",
        feedStatus: "imported",
        imported: 1,
        skipped: 0,
        failed: 0,
        total: 1,
      },
    ],
    [
      "subscription_updated without fetchFullContent",
      { ...base, type: "subscription_updated", subscriptionId: "s", tags: [], customTitle: null },
    ],
    [
      "new_entry without counts or subscriptionIds",
      { ...base, type: "new_entry", subscriptionId: null, entryId: "e", feedType: "saved" },
    ],
  ])("accepts %s", (_name, event) => {
    expect(parseUserEvent(JSON.stringify(event))).toMatchObject({ type: event.type });
  });

  it("keeps the feedType the previous release's SSE servers require on entry_updated", () => {
    const event = { ...base, type: "entry_updated", subscriptionId: null, entryId: "e", metadata };
    expect(parseUserEvent(JSON.stringify({ ...event, feedType: "email" }))).toMatchObject({
      feedType: "email",
    });
  });

  it("rejects an event without a timestamp", () => {
    const event = { userId: "user-1", updatedAt: base.updatedAt, type: "tag_deleted", tagId: "t" };
    expect(parseUserEvent(JSON.stringify(event))).toBeNull();
  });
});

describe("parseSiteStatusEvent", () => {
  it("accepts an announcement without updatedAt", () => {
    const event = {
      type: "announcement_changed",
      announcement: { id: "a", message: "Hi", level: "warning" },
      timestamp: base.timestamp,
    };
    expect(parseSiteStatusEvent(JSON.stringify(event))).toMatchObject(event);
  });
});
