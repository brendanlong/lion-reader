import { describe, it, expect } from "vitest";
import {
  subscriptionCreatedEvent,
  subscriptionUpdatedEvent,
} from "@/server/services/subscription-sync-events";
import type { Subscription } from "@/server/services/subscriptions";

const FEED_ID = "feed-uuid-never-sent";

const subscription: Subscription = {
  id: "sub-1",
  type: "web",
  url: "https://example.com/feed.xml",
  title: "My name",
  originalTitle: "Feed title",
  description: null,
  siteUrl: null,
  subscribedAt: new Date("2026-10-01T12:00:00Z"),
  unreadCount: 2,
  unreadCountAsOf: "2026-10-01T12:00:00.000000Z",
  tags: [{ id: "tag-1", name: "News", color: null }],
  fetchFullContent: true,
};

describe("subscription events", () => {
  // A row with its internal columns, as the base query returns it: its feed
  // id and stream serial must not reach the client.
  it("send only wire fields from whole rows", () => {
    const row = { ...subscription, feedId: FEED_ID, greaderStreamId: 12345n };
    for (const event of [subscriptionCreatedEvent(row), subscriptionUpdatedEvent(row)]) {
      const wire = JSON.stringify(event);
      expect(wire).not.toContain(FEED_ID);
      expect(wire).not.toContain("greaderStreamId");
    }
  });

  // App builds that predate the row read these: created shows
  // `customTitle ?? feed.title`, updated stores `customTitle ?? original title`.
  it("fill the deprecated fields so older apps show the row's title", () => {
    const created = subscriptionCreatedEvent(subscription);
    expect(created.subscription.customTitle ?? created.feed.title).toBe("My name");
    expect(created.feed).toEqual({
      type: "web",
      url: "https://example.com/feed.xml",
      title: "Feed title",
      description: null,
      siteUrl: null,
    });

    const updated = subscriptionUpdatedEvent(subscription);
    expect(updated).toMatchObject({
      customTitle: "My name",
      tags: subscription.tags,
      fetchFullContent: true,
    });
  });
});
