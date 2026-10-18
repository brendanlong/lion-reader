import { describe, it, expect } from "vitest";
import {
  subscriptionCreatedEvent,
  subscriptionUpdatedEvent,
} from "@/server/services/subscription-sync-events";

const FEED_ID = "feed-uuid-never-sent";

// A whole subscription row, as sync and the merge path pass it: its feed id
// and user id must not reach the client.
const subscription = {
  id: "sub-1",
  userId: "user-1",
  feedId: FEED_ID,
  type: "web" as const,
  customTitle: "My name",
  subscribedAt: new Date("2026-10-01T12:00:00Z"),
  unreadCount: 2,
  fetchFullContent: true,
};
const tag = { id: "tag-1", name: "News", color: null, userId: "user-1" };
const feed = {
  id: FEED_ID,
  url: "https://example.com/feed.xml",
  title: null,
  description: null,
  siteUrl: null,
};

describe("subscription events", () => {
  it("send only wire fields from whole rows", () => {
    const events = [
      subscriptionCreatedEvent(subscription, [tag], feed),
      subscriptionUpdatedEvent(subscription, [tag]),
    ];
    for (const event of events) {
      const wire = JSON.stringify(event);
      expect(wire).not.toContain(FEED_ID);
      expect(wire).not.toContain("user-1");
    }
  });

  // As user_feeds.original_title, which the client keeps as the title a
  // cleared custom title falls back to.
  it.each([
    ["a titled feed's own title", { ...feed, title: "Feed title" }, "Feed title"],
    ["the custom title for an untitled feed", feed, "My name"],
    ["the custom title without a feed", null, "My name"],
  ])("titles the feed with %s", (_, source, expected) => {
    expect(subscriptionCreatedEvent(subscription, [], source).feed.title).toBe(expected);
  });
});
