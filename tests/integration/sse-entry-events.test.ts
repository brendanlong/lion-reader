/**
 * Entry events through the real SSE route (#1846): email and saved entries
 * have exactly one recipient, so they're published on that user's channel; a
 * web entry is published once on its feed's channel for every subscriber.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  userEntries,
  ingestAddresses,
} from "../../src/server/db/schema";
import {
  getFeedEventsChannel,
  getUserEventsChannel,
  publishFeedEvent,
  publishUserEvent,
} from "../../src/server/redis/pubsub";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import { getSavedSubscriptionId } from "../../src/server/services/subscriptions";
import { uploadArticle } from "../../src/server/services/saved";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { openSseStream, type SseStream } from "../utils/sse";
import {
  createTestEmailSubscription,
  createTestEntry,
  createTestFeed,
  createTestIngestAddress,
  createTestSubscription,
  createTestUser,
} from "./helpers";

// A plain client for PUBSUB NUMSUB, independent of the shared subscriber.
let redis: Redis;

beforeAll(() => {
  redis = new Redis(process.env.REDIS_URL!);
});

async function clean(): Promise<void> {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(ingestAddresses);
  await db.delete(users);
}

beforeEach(clean);
afterAll(async () => {
  await clean();
  await redis.quit();
});

/** Waits until something in this process subscribes to every channel. */
async function waitForSubscribers(...channels: string[]): Promise<void> {
  const deadline = Date.now() + 5000;
  for (const channel of channels) {
    while (true) {
      const [, count] = (await redis.call("pubsub", "numsub", channel)) as [string, number];
      if (Number(count) > 0) break;
      if (Date.now() > deadline) throw new Error(`Nothing subscribed to ${channel}`);
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

/**
 * Publishes a marker on the user's channel and waits for it. Everything
 * published to the stream before the marker has arrived by then, so a test can
 * show an event was NOT delivered (or delivered only once).
 */
async function waitForMarker(userId: string, stream: SseStream): Promise<void> {
  const marker = generateUuidv7();
  await publishUserEvent({ type: "tag_deleted", userId, tagId: marker, updatedAt: new Date() });
  await stream.waitFor("tag_deleted", (data) => data.tagId === marker);
}

/** The fields under test of every new_entry/entry_updated the stream got. */
function entryEvents(stream: SseStream) {
  return ["new_entry", "entry_updated"].flatMap((event) =>
    stream.events(event).map((data) => ({
      event,
      entryId: data.entryId,
      subscriptionId: data.subscriptionId,
      feedTitle: (data.entry as { feedTitle?: string } | undefined)?.feedTitle,
      type: (data.entry as { type?: string } | undefined)?.type,
    }))
  );
}

describe("SSE entry events", () => {
  it("delivers email and saved entries to their user once, and web entries via the feed", async () => {
    const userId = await createTestUser({ emailPrefix: "sse-entries" });
    const otherUserId = await createTestUser({ emailPrefix: "sse-entries-other" });

    const webFeedId = await createTestFeed();
    const webSubscriptionId = await createTestSubscription(userId, webFeedId);
    const webEntryId = await createTestEntry(webFeedId, { userIds: [userId] });

    const sender = "news@example.com";
    // The user renamed the newsletter; its live new_entry must say so.
    const emailSubscriptionId = await createTestEmailSubscription(userId, {
      emailSender: sender,
      customTitle: "My Newsletter",
    });
    const ingestToken = `sse-${generateUuidv7()}`;
    await createTestIngestAddress(userId, { token: ingestToken });

    const stream = await openSseStream(userId);
    const otherStream = await openSseStream(otherUserId);
    try {
      await waitForSubscribers(
        getUserEventsChannel(userId),
        getUserEventsChannel(otherUserId),
        getFeedEventsChannel(webFeedId)
      );

      const email = await processInboundEmail({
        to: `${ingestToken}@ingest.lionreader.com`,
        from: { address: sender, name: "News" },
        subject: "Issue 1",
        messageId: `<${generateUuidv7()}@example.com>`,
        html: "<p>Hello</p>",
        headers: {},
      });
      expect(email.success).toBe(true);
      const saved = await uploadArticle(db, userId, { content: "Body", title: "Saved one" });
      await publishUserEvent({
        type: "entry_updated",
        userId,
        subscriptionId: null,
        entryId: saved.id,
        updatedAt: new Date(),
        metadata: { title: "Renamed", author: null, summary: null, url: null, publishedAt: null },
      });
      // As the feed worker does after fanning out a fetched entry.
      await publishFeedEvent({
        type: "new_entry",
        feedId: webFeedId,
        entryId: webEntryId,
        updatedAt: new Date(),
        feedType: "web",
      });

      // Every publish above is fire-and-forget, so wait for all of them before
      // the marker, which then catches any duplicate.
      await stream.waitFor("new_entry", (data) => data.entryId === email.entryId);
      await stream.waitFor("new_entry", (data) => data.entryId === saved.id);
      await stream.waitFor("entry_updated", (data) => data.entryId === saved.id);
      await stream.waitFor("new_entry", (data) => data.entryId === webEntryId);
      await waitForMarker(userId, stream);

      const received = entryEvents(stream);
      expect(received).toHaveLength(4);
      expect(received).toEqual(
        expect.arrayContaining([
          {
            event: "new_entry",
            entryId: email.entryId,
            subscriptionId: emailSubscriptionId,
            feedTitle: "My Newsletter",
            type: "email",
          },
          {
            // A saved article's origin is the saved subscription (#1846).
            event: "new_entry",
            entryId: saved.id,
            subscriptionId: await getSavedSubscriptionId(db, userId),
            feedTitle: "Saved Articles",
            type: "saved",
          },
          {
            event: "entry_updated",
            entryId: saved.id,
            subscriptionId: null,
            feedTitle: undefined,
            type: undefined,
          },
          {
            event: "new_entry",
            entryId: webEntryId,
            subscriptionId: webSubscriptionId,
            feedTitle: undefined,
            type: undefined,
          },
        ])
      );
      expect(stream.events("entry_updated")[0].metadata).toMatchObject({ title: "Renamed" });
      // Clients read the entry's own type; events name no feed (#1846).
      expect(stream.text).not.toContain("feedType");

      await waitForMarker(otherUserId, otherStream);
      expect(entryEvents(otherStream)).toEqual([]);
    } finally {
      await stream.close();
      await otherStream.close();
    }
  });

  it("follows each new_entry of a burst with counts for its subscription", async () => {
    const userId = await createTestUser({ emailPrefix: "sse-burst" });
    const feedIds = [await createTestFeed(), await createTestFeed()];
    const subscriptionIds = [
      await createTestSubscription(userId, feedIds[0]),
      await createTestSubscription(userId, feedIds[1]),
    ];
    const published = [0, 1, 0, 1, 0].map((i) => ({ i, entryId: "" }));
    for (const p of published) {
      p.entryId = await createTestEntry(feedIds[p.i], { userIds: [userId] });
    }

    const stream = await openSseStream(userId);
    try {
      await waitForSubscribers(...feedIds.map(getFeedEventsChannel));
      await Promise.all(
        published.map((p) =>
          publishFeedEvent({
            type: "new_entry",
            feedId: feedIds[p.i],
            entryId: p.entryId,
            updatedAt: new Date(),
            feedType: "web",
          })
        )
      );
      for (const p of published) {
        await stream.waitFor("new_entry", (data) => data.entryId === p.entryId);
      }

      // How a burst splits into count-bearing events depends on timing, but
      // the last event carries counts, and every event's subscription is
      // counted by it or a later one.
      const received = stream.events("new_entry");
      const countedSubscriptions = (data: Record<string, unknown>) =>
        (
          (data.counts as { subscriptions: Array<{ id: string }> } | undefined)?.subscriptions ?? []
        ).map((s) => s.id);
      expect(received.at(-1)?.counts).toBeDefined();
      received.forEach((data, index) => {
        expect(received.slice(index).flatMap(countedSubscriptions)).toContain(data.subscriptionId);
      });
      expect(new Set(received.map((data) => data.subscriptionId))).toEqual(
        new Set(subscriptionIds)
      );
    } finally {
      await stream.close();
    }
  });
});
