/**
 * Integration tests for WebSub content-notification ingest.
 *
 * `ingestWebsubNotification` is the path a hub push takes into the entry
 * pipeline. It never throws — it reports an outcome the callback route turns
 * into a status code — which makes wrong behaviour easy to miss; these tests pin
 * the parts that reach subscribers.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  entries,
  feeds,
  subscriptions,
  userEntries,
  users,
  websubHubStats,
} from "../../src/server/db/schema";
import { ingestWebsubNotification } from "../../src/server/feed/websub-notification";
import { createTestFeed, createTestSubscription, createTestUser } from "./helpers";

const HUB_URL = "https://hub.example.com/";

/** A one-item RSS document, the shape a hub pushes for a single post. */
function pushBody(guid: string, title: string, pubDate: Date): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <item>
      <title>${title}</title>
      <link>https://example.com/${guid}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate.toUTCString()}</pubDate>
      <description>Body of ${title}</description>
    </item>
  </channel>
</rss>`;
}

async function seedPushFeed(emailPrefix: string, lastPoll: Date) {
  const feedId = await createTestFeed({
    url: `https://example.com/${emailPrefix}.xml`,
    hubUrl: HUB_URL,
    websubActive: true,
    lastFetchedAt: lastPoll,
    lastEntriesUpdatedAt: lastPoll,
  });
  const userId = await createTestUser({ emailPrefix });
  const subscriptionId = await createTestSubscription(userId, feedId);
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId));
  return { feed, userId, subscriptionId };
}

async function getUserEntry(userId: string) {
  const [row] = await db
    .select({ read: userEntries.read, guid: entries.guid, isBackfill: entries.isBackfill })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .where(eq(userEntries.userId, userId));
  return row;
}

async function getHubStats() {
  const [row] = await db.select().from(websubHubStats).where(eq(websubHubStats.hubUrl, HUB_URL));
  return row;
}

describe("ingestWebsubNotification", () => {
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(websubHubStats);
    await db.delete(feeds);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(websubHubStats);
    await db.delete(feeds);
    await db.delete(users);
  });

  it("delivers a genuinely new pushed article unread and credits the hub", async () => {
    const now = Date.now();
    const { feed, userId, subscriptionId } = await seedPushFeed(
      "pushfresh",
      new Date(now - 60 * 60 * 1000)
    );

    const outcome = await ingestWebsubNotification(
      feed,
      pushBody("fresh-1", "Today&apos;s post", new Date(now - 60 * 1000))
    );
    expect(outcome).toBe("processed");

    const row = await getUserEntry(userId);
    expect(row.guid).toBe("fresh-1");
    expect(row.read).toBe(false);
    expect(row.isBackfill).toBe(false);

    const [subscription] = await db
      .select({ unreadCount: subscriptions.unreadCount })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));
    expect(subscription.unreadCount).toBe(1);

    expect((await getHubStats()).articlesAnnouncedByHub).toBe(1);
  });

  it("delivers an archive replay read, and doesn't credit the hub for it (#1500)", async () => {
    // The #1500 vector: a bulk edit of the publisher's archive fires the hub once
    // per touched post, each carrying an article we've never seen, dated years
    // ago. A push doesn't advance last_fetched_at, so it stays the last real
    // poll — which is exactly the "were we watching?" reference the guard needs.
    const { feed, userId, subscriptionId } = await seedPushFeed(
      "pusharchive",
      new Date(Date.now() - 60 * 60 * 1000)
    );

    const outcome = await ingestWebsubNotification(
      feed,
      pushBody("archive-1", "Ukraine Post #5", new Date("2022-03-01T00:00:00Z"))
    );
    expect(outcome).toBe("processed");

    const row = await getUserEntry(userId);
    expect(row.guid).toBe("archive-1");
    expect(row.read).toBe(true);
    expect(row.isBackfill).toBe(true);

    const [subscription] = await db
      .select({ unreadCount: subscriptions.unreadCount })
      .from(subscriptions)
      .where(eq(subscriptions.id, subscriptionId));
    expect(subscription.unreadCount).toBe(0);

    // The tally is about how new articles first reach us; an archive replay
    // isn't one, so the hub gets no credit for it.
    expect(await getHubStats()).toBeUndefined();
  });

  it("leaves last_fetched_at and last_entries_updated_at alone, and clears body_hash", async () => {
    const lastPoll = new Date(Date.now() - 60 * 60 * 1000);
    const { feed, userId } = await seedPushFeed("pushmeta", lastPoll);
    await db.update(feeds).set({ bodyHash: "stale-hash" }).where(eq(feeds.id, feed.id));

    await ingestWebsubNotification(feed, pushBody("fresh-1", "New", new Date()));

    const [after] = await db.select().from(feeds).where(eq(feeds.id, feed.id));
    expect(after.lastFetchedAt?.toISOString()).toBe(lastPoll.toISOString());
    expect(after.lastEntriesUpdatedAt?.toISOString()).toBe(lastPoll.toISOString());
    expect(after.bodyHash).toBeNull();

    // The pushed entry is stamped above the (unmoved) generation pointer, which
    // is what keeps it visible to a new subscriber via the `>=` populate.
    const [entry] = await db.select().from(entries).where(eq(entries.feedId, feed.id));
    expect(entry.lastSeenAt!.getTime()).toBeGreaterThan(lastPoll.getTime());
    expect(await getUserEntry(userId)).toBeDefined();
  });

  it("reports an unparseable push body instead of throwing", async () => {
    const { feed, userId } = await seedPushFeed("pushgarbage", new Date(Date.now() - 60 * 1000));

    // Final, not retryable: redelivering the same bytes would fail identically,
    // so the route acks the hub rather than asking for a retry.
    await expect(ingestWebsubNotification(feed, "not a feed at all")).resolves.toBe("unparseable");

    expect(await db.select().from(entries).where(eq(entries.feedId, feed.id))).toHaveLength(0);
    expect(await getUserEntry(userId)).toBeUndefined();
  });
});
