/**
 * One SSE connection's message handling (`startSseConnection`), against real
 * Redis and Postgres: what reaches `send`, and in what order.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { publishFeedEvent, publishUserEvent } from "../../src/server/redis/pubsub";
import {
  getUserFeedSubscriptionMap,
  startSseConnection,
  type SseConnection,
} from "../../src/server/realtime/sse-connection";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { toNewEntryListData } from "../../src/lib/events/schemas";
import { createTestEntry, createTestFeed, createTestSubscription, createTestUser } from "./helpers";

async function clean(): Promise<void> {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

beforeEach(clean);
afterAll(clean);

interface SentEvent {
  event: string;
  data: Record<string, unknown>;
}

interface RecordedConnection {
  sent: SentEvent[];
  /** Resolves once `predicate` holds for some sent event. */
  waitFor(predicate: (event: SentEvent) => boolean): Promise<void>;
  close(): void;
}

/** Starts a connection for `userId` recording what it sends, once it's subscribed. */
async function connect(userId: string): Promise<RecordedConnection> {
  const sent: SentEvent[] = [];
  const connection: SseConnection | null = startSseConnection({
    userId,
    feedSubscriptions: await getUserFeedSubscriptionMap(userId),
    send(message) {
      const event = /^event: (.*)$/m.exec(message)![1];
      const data = /^data: (.*)$/m.exec(message)![1];
      sent.push({ event, data: JSON.parse(data) as Record<string, unknown> });
    },
  });
  if (!connection) throw new Error("Redis is not configured");
  await connection.subscribed;

  return {
    sent,
    async waitFor(predicate) {
      const deadline = Date.now() + 5000;
      while (!sent.some(predicate)) {
        if (Date.now() > deadline) throw new Error("Timed out waiting for an SSE event");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    },
    close: () => connection.close(),
  };
}

/** Publishes a tag_deleted marker on the user's channel and waits for it to be sent. */
async function sendMarker(userId: string, connection: RecordedConnection): Promise<string> {
  const marker = generateUuidv7();
  await publishUserEvent({
    type: "tag_deleted",
    userId: userId,
    tagId: marker,
    updatedAt: new Date(),
  });
  await connection.waitFor((e) => e.event === "tag_deleted" && e.data.tagId === marker);
  return marker;
}

describe("startSseConnection", () => {
  it("sends events in publish order, though new_entry waits on a count query", async () => {
    const userId = await createTestUser({ emailPrefix: "sse-order" });
    const feedId = await createTestFeed();
    const subscriptionId = await createTestSubscription(userId, feedId);
    const firstEntryId = await createTestEntry(feedId, { userIds: [userId] });
    const secondEntryId = await createTestEntry(feedId, { userIds: [userId] });
    const connection = await connect(userId);

    try {
      await publishFeedEvent({
        type: "new_entry",
        feedId: feedId,
        entryId: firstEntryId,
        updatedAt: new Date(),
        feedType: "web",
      });
      const firstTagId = generateUuidv7();
      await publishUserEvent({
        type: "tag_deleted",
        userId: userId,
        tagId: firstTagId,
        updatedAt: new Date(),
      });
      await publishFeedEvent({
        type: "new_entry",
        feedId: feedId,
        entryId: secondEntryId,
        updatedAt: new Date(),
        feedType: "web",
      });
      const lastTagId = await sendMarker(userId, connection);

      expect(connection.sent.map(({ event, data }) => [event, data.entryId ?? data.tagId])).toEqual(
        [
          ["new_entry", firstEntryId],
          ["tag_deleted", firstTagId],
          ["new_entry", secondEntryId],
          ["tag_deleted", lastTagId],
        ]
      );
      // The feed's event is translated to this user's subscription, with
      // their absolute counts.
      expect(connection.sent[0].data).toMatchObject({
        subscriptionId,
        subscriptionIds: [subscriptionId],
        counts: {
          all: { unread: 2 },
          subscriptions: [{ id: subscriptionId, unread: 2, tagIds: [] }],
        },
      });
    } finally {
      connection.close();
    }
  });

  it("stops sending a feed's entries once its subscription is deleted, for that user only", async () => {
    const leaverId = await createTestUser({ emailPrefix: "sse-leaver" });
    const stayerId = await createTestUser({ emailPrefix: "sse-stayer" });
    const feedId = await createTestFeed();
    const leaverSubscriptionId = await createTestSubscription(leaverId, feedId);
    const stayerSubscriptionId = await createTestSubscription(stayerId, feedId);
    const entryId = await createTestEntry(feedId, { userIds: [stayerId] });
    const leaver = await connect(leaverId);
    const stayer = await connect(stayerId);

    try {
      await publishUserEvent({
        type: "subscription_deleted",
        userId: leaverId,
        feedId: feedId,
        subscriptionId: leaverSubscriptionId,
        updatedAt: new Date(),
      });
      await leaver.waitFor((e) => e.event === "subscription_deleted");
      await publishFeedEvent({
        type: "new_entry",
        feedId: feedId,
        entryId: entryId,
        updatedAt: new Date(),
        feedType: "web",
      });

      // Both connections share one Redis subscriber, so releasing the
      // leaver's listener must not unsubscribe the feed's channel.
      await stayer.waitFor((e) => e.event === "new_entry" && e.data.entryId === entryId);
      expect(stayer.sent.find((e) => e.event === "new_entry")?.data.subscriptionId).toBe(
        stayerSubscriptionId
      );
      await sendMarker(leaverId, leaver);
      expect(leaver.sent.map((e) => e.event)).toEqual(["subscription_deleted", "tag_deleted"]);
    } finally {
      leaver.close();
      stayer.close();
    }
  });

  // During a deploy, a previous release's servers publish subscription events
  // without `row`; their deprecated `customTitle` is the raw custom title.
  it.each([
    [
      "subscription_created",
      (userId: string, feedId: string, subscriptionId: string, customTitle: string) =>
        publishUserEvent({
          type: "subscription_created",
          userId,
          feedId,
          subscriptionId,
          updatedAt: new Date(),
          subscription: {
            id: subscriptionId,
            customTitle,
            subscribedAt: new Date().toISOString(),
            unreadCount: 1,
            tags: [],
          },
          feed: { type: "web", url: null, title: "Feed", description: null, siteUrl: null },
        }),
    ],
    [
      "subscription_updated",
      (userId: string, _feedId: string, subscriptionId: string, customTitle: string) =>
        publishUserEvent({
          type: "subscription_updated",
          userId,
          subscriptionId,
          updatedAt: new Date(),
          tags: [],
          customTitle,
        }),
    ],
  ])("applies a row-less %s's custom title to new_entry", async (_name, publishOldEvent) => {
    const userId = await createTestUser({ emailPrefix: "sse-old-release" });
    const feedId = await createTestFeed({ title: "Feed" });
    const subscriptionId = await createTestSubscription(userId, feedId);
    const entryId = await createTestEntry(feedId, { userIds: [userId] });
    const connection = await connect(userId);

    try {
      await publishOldEvent(userId, feedId, subscriptionId, "Old Server Name");
      await connection.waitFor((e) => e.data.subscriptionId === subscriptionId);
      await publishFeedEvent({
        type: "new_entry",
        feedId,
        entryId,
        updatedAt: new Date(),
        feedType: "web",
        entry: {
          ...toNewEntryListData({ type: "web", fetchedAt: new Date() }, "Feed"),
          type: "web",
        },
      });
      await connection.waitFor((e) => e.event === "new_entry");
      expect(connection.sent.find((e) => e.event === "new_entry")?.data.entry).toMatchObject({
        feedTitle: "Old Server Name",
      });
    } finally {
      connection.close();
    }
  });
});
