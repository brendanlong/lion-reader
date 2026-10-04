/**
 * Clients only ever see subscription IDs, never feed IDs (root CLAUDE.md, "API
 * Conventions"). These tests look for the feed's UUID anywhere in what the
 * client-facing endpoints send, so a new field leaking it fails here.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { GET as eventsGet } from "../../src/app/api/v1/events/route";
import { createSession } from "../../src/server/auth/session";
import {
  publishNewEntry,
  publishSubscriptionCreated,
  publishSubscriptionDeleted,
} from "../../src/server/redis/pubsub";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

async function clean(): Promise<void> {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

async function seed() {
  const userId = await createTestUser({ emailPrefix: "feed-id-exposure" });
  const now = new Date();
  // The test factory's default title and URL embed the feed id.
  const feedId = await createTestFeed({
    title: "Feed",
    url: "https://example.com/feed.xml",
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
    consecutiveFailures: 1,
  });
  const subscriptionId = await createTestSubscription(userId, feedId);
  const entryId = await createTestEntry(feedId, { userIds: [userId] });
  return { userId, feedId, subscriptionId, entryId };
}

describe("feed IDs never reach clients", () => {
  beforeEach(clean);
  afterAll(clean);

  it("tRPC/REST responses carry only subscription IDs", async () => {
    const { userId, feedId, subscriptionId, entryId } = await seed();
    const caller = createCaller(await createAuthContext(userId));
    const longAgo = new Date("2020-01-01T00:00:00Z").toISOString();

    const list = await caller.entries.list({});
    const responses = {
      list,
      get: await caller.entries.get({ id: entryId }),
      getMany: await caller.entries.getMany({ ids: [entryId] }),
      sync: await caller.sync.events({
        cursors: { entries: longAgo, subscriptions: longAgo },
      }),
      subscriptions: await caller.subscriptions.list({}),
      subscription: await caller.subscriptions.get({ id: subscriptionId }),
      brokenFeeds: await caller.brokenFeeds.list(),
      feedStats: await caller.feedStats.list(),
    };

    // Guard against a vacuous pass: each response holds the seeded data.
    expect(list.items.map((item) => item.id)).toEqual([entryId]);
    expect(responses.sync.events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["new_entry", "entry_state_changed", "subscription_created"])
    );
    expect(responses.brokenFeeds.items).toHaveLength(1);
    expect(responses.feedStats.items).toHaveLength(1);

    for (const [name, response] of Object.entries(responses)) {
      expect(JSON.stringify(response), name).not.toContain(feedId);
    }

    // Released Android builds require these keys; they carry the subscription id.
    expect(list.items[0].feedId).toBe(subscriptionId);
    const created = responses.sync.events.find((event) => event.type === "subscription_created");
    expect(created).toMatchObject({
      subscription: { feedId: subscriptionId },
      feed: { id: subscriptionId },
    });
  });

  it("the SSE stream carries only subscription IDs", async () => {
    const { userId, feedId, subscriptionId, entryId } = await seed();
    const otherFeedId = await createTestFeed({
      title: "Other",
      url: "https://example.com/other.xml",
    });
    const otherSubscriptionId = await createTestSubscription(userId, otherFeedId);
    const { token } = await createSession(db, { userId });
    const res = await eventsGet(
      new Request("http://localhost:3000/api/v1/events", {
        headers: { cookie: `session=${token}` },
      })
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";

    try {
      // Publish until the stream has subscribed to the feed's channel.
      const deadline = Date.now() + 5000;
      while ((await publishNewEntry(feedId, entryId, new Date(), "web", undefined)) === 0) {
        if (Date.now() > deadline) throw new Error("SSE stream never subscribed");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await publishSubscriptionCreated(
        userId,
        otherFeedId,
        otherSubscriptionId,
        new Date(),
        { customTitle: null, subscribedAt: new Date().toISOString(), unreadCount: 0, tags: [] },
        {
          type: "web",
          url: "https://example.com/other.xml",
          title: null,
          description: null,
          siteUrl: null,
        }
      );
      await publishSubscriptionDeleted(userId, feedId, subscriptionId, new Date());

      while (!text.includes("event: subscription_deleted")) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream ended early");
        text += decoder.decode(value, { stream: true });
      }
    } finally {
      await reader.cancel();
    }

    expect(text).toContain("event: new_entry");
    expect(text).toContain("event: subscription_created");
    expect(text).not.toContain(feedId);
    expect(text).not.toContain(otherFeedId);

    const createdLine = text
      .split("\n\n")
      .find((block) => block.includes("event: subscription_created"))!
      .split("\n")
      .find((line) => line.startsWith("data: "))!;
    expect(JSON.parse(createdLine.slice("data: ".length))).toMatchObject({
      subscription: { feedId: otherSubscriptionId },
      feed: { id: otherSubscriptionId },
    });
  });
});
