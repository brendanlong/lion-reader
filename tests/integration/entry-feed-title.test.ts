/**
 * An entry's `feedTitle` is its source as the user sees it: their custom
 * title for the subscription, else the feed's own. Every read that hands it to
 * a client (the web app, the Android app, MCP, Google Reader's item origin)
 * must agree, or a renamed feed shows its original name on its articles.
 *
 * A second user subscribed to the same feed without renaming it guards the
 * other direction: the custom title is per-user and never leaks.
 */

import { describe, it, expect, beforeEach, afterAll, beforeAll } from "vitest";
import Redis from "ioredis";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { GET as eventsGet } from "../../src/app/api/v1/events/route";
import { createSession } from "../../src/server/auth/session";
import * as entriesService from "../../src/server/services/entries";
import {
  getUserEventsChannel,
  publishNewEntry,
  publishSubscriptionUpdated,
} from "../../src/server/redis/pubsub";
import { toNewEntryListData } from "../../src/lib/events/schemas";
import { subscribeAndDrain, waitForMessage } from "../utils/pubsub";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

const FEED_TITLE = "Original Feed Name";
const CUSTOM_TITLE = "My Name For It";

let subscriber: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL must be set for integration tests");
  subscriber = new Redis(redisUrl);
});

async function clean(): Promise<void> {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

beforeEach(clean);
afterAll(async () => {
  await subscriber.quit();
  await clean();
});

/** One feed, read by a user who renamed it and one who didn't. */
async function seed() {
  const now = new Date();
  const feedId = await createTestFeed({
    title: FEED_TITLE,
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
  });
  const renamer = await createTestUser({ emailPrefix: "feed-title-renamer" });
  const other = await createTestUser({ emailPrefix: "feed-title-other" });
  const subscriptionId = await createTestSubscription(renamer, feedId, {
    customTitle: CUSTOM_TITLE,
  });
  await createTestSubscription(other, feedId);
  const entryId = await createTestEntry(feedId, {
    title: "Zymurgy roundup",
    userIds: [renamer, other],
  });
  return { feedId, renamer, other, subscriptionId, entryId };
}

type Reader = (userId: string, entryId: string) => Promise<string | null | undefined>;

describe("entry feedTitle is the user's subscription title", () => {
  it.each<[string, Reader]>([
    [
      "entries.list",
      async (userId, entryId) => {
        const caller = createCaller(await createAuthContext(userId));
        const { items } = await caller.entries.list({});
        return items.find((item) => item.id === entryId)?.feedTitle;
      },
    ],
    [
      "search",
      async (userId, entryId) => {
        const { items } = await entriesService.listEntries(db, {
          userId,
          query: "zymurgy",
          showSpam: false,
        });
        return items.find((item) => item.id === entryId)?.feedTitle;
      },
    ],
    [
      "entries.get",
      async (userId, entryId) => {
        const caller = createCaller(await createAuthContext(userId));
        return (await caller.entries.get({ id: entryId })).entry.feedTitle;
      },
    ],
    [
      "sync.events catch-up",
      async (userId, entryId) => {
        const caller = createCaller(await createAuthContext(userId));
        const { events } = await caller.sync.events({
          cursors: { entries: new Date(Date.now() - 60_000).toISOString() },
        });
        const event = events.find((e) => e.type === "new_entry" && e.entryId === entryId);
        return event?.type === "new_entry" ? event.entry?.feedTitle : undefined;
      },
    ],
    [
      "entry_state_changed unread payload",
      async (userId, entryId) => {
        const channel = getUserEventsChannel(userId);
        await subscribeAndDrain(subscriber, channel, () =>
          entriesService.markEntriesRead(db, userId, [{ id: entryId }], true)
        );
        const message = waitForMessage(subscriber, channel);
        await entriesService.markEntriesRead(db, userId, [{ id: entryId }], false);
        const event = JSON.parse(await message);
        await subscriber.unsubscribe(channel);
        return event.entry?.feedTitle;
      },
    ],
  ])("%s", async (_name, read) => {
    const { renamer, other, entryId } = await seed();

    expect(await read(renamer, entryId)).toBe(CUSTOM_TITLE);
    expect(await read(other, entryId)).toBe(FEED_TITLE);
  });

  it("live new_entry events carry the custom title, following renames", async () => {
    const { feedId, renamer, subscriptionId, entryId } = await seed();
    const { token } = await createSession(db, { userId: renamer });
    const res = await eventsGet(
      new Request("http://localhost:3000/api/v1/events", {
        headers: { cookie: `session=${token}` },
      })
    );
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    // Feed channels are shared by every subscriber, so the publisher stamps
    // the feed's own title; the stream must swap in this user's.
    const payload = toNewEntryListData({ fetchedAt: new Date() }, FEED_TITLE);
    const newEntryTitles: Array<string | null> = [];
    let buffer = "";

    async function readNewEntryTitle(): Promise<void> {
      const want = newEntryTitles.length + 1;
      while (newEntryTitles.length < want) {
        const { value, done } = await reader.read();
        if (done) throw new Error("SSE stream ended early");
        buffer += decoder.decode(value, { stream: true });
        const messages = buffer.split("\n\n");
        buffer = messages.pop() ?? "";
        for (const message of messages) {
          if (!message.startsWith("event: new_entry")) continue;
          const data = message.split("\n").find((line) => line.startsWith("data: "));
          newEntryTitles.push(JSON.parse(data!.slice("data: ".length)).entry.feedTitle);
        }
      }
    }

    try {
      // Publish until the stream has subscribed to the feed's channel.
      const deadline = Date.now() + 5000;
      while ((await publishNewEntry(feedId, entryId, new Date(), "web", payload)) === 0) {
        if (Date.now() > deadline) throw new Error("SSE stream never subscribed");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await readNewEntryTitle();

      // Clearing the custom title falls back to the feed's.
      await publishSubscriptionUpdated(renamer, subscriptionId, new Date(), [], null);
      await publishNewEntry(feedId, entryId, new Date(), "web", payload);
      await readNewEntryTitle();
    } finally {
      await reader.cancel();
    }

    expect(newEntryTitles).toEqual([CUSTOM_TITLE, FEED_TITLE]);
  });
});
