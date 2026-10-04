/**
 * Collections (#1806) through the surfaces besides tRPC: the MCP tools an
 * assistant uses to curate, the SSE event other tabs apply, and the Google
 * Reader API, which leaves collections out (its clients file each item under
 * its source feed, so a collection would show a count with no items).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import { db } from "../../src/server/db";
import {
  collectionEntries,
  entries,
  feeds,
  subscriptionTags,
  subscriptions,
  tags,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { registerTools } from "../../src/server/mcp/tools";
import { addEntriesToCollection, createCollection } from "../../src/server/services/collections";
import { listEntries } from "../../src/server/services/entries";
import {
  getGreaderUnreadCounts,
  listGreaderSubscriptions,
} from "../../src/server/google-reader/subscriptions";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";
import { subscribeAndDrain, waitForMessage } from "../utils/pubsub";
import {
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

let subscriber: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL must be set for integration tests");
  subscriber = new Redis(redisUrl);
});

async function cleanup(): Promise<void> {
  await db.delete(collectionEntries);
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionTags);
  await db.delete(tags);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

beforeEach(cleanup);
afterAll(async () => {
  await subscriber.quit();
  await cleanup();
});

function callTool(name: string, userId: string, args: unknown) {
  const tool = registerTools().find((t) => t.name === name);
  if (!tool) throw new Error(`Tool not registered: ${name}`);
  return tool.handler(db, userId, args);
}

async function userWithEntry() {
  const userId = await createTestUser();
  const feedId = await createTestFeed();
  const sourceId = await createTestSubscription(userId, feedId);
  const entryId = await createTestEntry(feedId, { userIds: [userId] });
  return { userId, sourceId, entryId };
}

describe("MCP curation tools", () => {
  it("create, add, tag, list and remove a collection", async () => {
    const { userId, entryId } = await userWithEntry();
    const tagId = await createTestTag(userId);

    const collection = (await callTool("create_collection", userId, { name: "Top" })) as {
      id: string;
      type: string;
    };
    expect(collection.type).toBe("collection");
    expect(
      await callTool("add_to_collection", userId, {
        collectionId: collection.id,
        entryIds: [entryId, entryId],
      })
    ).toEqual({ entryIds: [entryId] });
    await callTool("set_subscription_tags", userId, {
      subscriptionId: collection.id,
      tagIds: [tagId, tagId],
    });

    const listed = (await callTool("list_subscriptions", userId, { type: "collection" })) as {
      subscriptions: Array<{ id: string; tags: Array<{ id: string }> }>;
    };
    expect(listed.subscriptions.map((s) => [s.id, s.tags.map((t) => t.id)])).toEqual([
      [collection.id, [tagId]],
    ]);
    const { items } = await listEntries(db, { userId, tagId, showSpam: false });
    expect(items.map((i) => i.id)).toEqual([entryId]);

    expect(
      await callTool("remove_from_collection", userId, {
        collectionId: collection.id,
        entryIds: [entryId],
      })
    ).toEqual({ entryIds: [entryId] });
  });
});

describe("collection_entries_changed", () => {
  it("publishes the change and its counts on the user's channel", async () => {
    const { userId, entryId } = await userWithEntry();
    const channel = getUserEventsChannel(userId);
    let collectionId = "";
    await subscribeAndDrain(subscriber, channel, async () => {
      collectionId = (await createCollection(db, userId, "C")).subscription.id;
    });
    const message = waitForMessage(subscriber, channel);

    await addEntriesToCollection(db, userId, collectionId, [entryId]);

    expect(JSON.parse(await message)).toMatchObject({
      type: "collection_entries_changed",
      subscriptionId: collectionId,
      entryIds: [entryId],
      added: true,
      counts: { subscriptions: [{ id: collectionId, unread: 1 }] },
    });
  });
});

describe("Google Reader", () => {
  it("leaves collections out of the subscription list and unread counts", async () => {
    const { userId, sourceId, entryId } = await userWithEntry();
    const { subscription } = await createCollection(db, userId, "C");
    await addEntriesToCollection(db, userId, subscription.id, [entryId]);

    expect((await listGreaderSubscriptions(db, userId)).map((s) => s.id)).toEqual([sourceId]);
    const counts = await getGreaderUnreadCounts(db, userId);
    expect(counts.subscriptions).toHaveLength(1);
    expect(counts.readingListUnread).toBe(1);
  });
});
