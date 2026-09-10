/**
 * Integration tests for the `fetch_feed` job handler.
 *
 * `handleFetchFeed` is the only caller of the feed-fetch pipeline, and the parts
 * that decide what a subscriber sees — conditional GET, the body-hash
 * short-circuit, the backfill guard's `previousLastFetchedAt` wiring, backoff on
 * failure — are only reachable through a real HTTP response. So these drive it
 * against loopback servers (`.env.test` sets ALLOW_PRIVATE_NETWORK_FETCH) rather
 * than testing `processEntries` in isolation.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds, subscriptions, userEntries, users } from "../../src/server/db/schema";
import { handleFetchFeed } from "../../src/server/jobs/handlers/fetch-feed";
import { createTestFeed, createTestSubscription, createTestUser } from "./helpers";

/** What the loopback origin should answer with on the next request. */
interface FeedResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

let server: Server;
let baseUrl: string;
/** Set per test; the server replays it for every request. */
let nextResponse: FeedResponse;
/** Headers of every request the server saw, in order. */
let receivedHeaders: IncomingHttpHeaders[];

function rss(items: Array<{ guid: string; title: string; pubDate: Date }>): string {
  const body = items
    .map(
      (item) => `    <item>
      <title>${item.title}</title>
      <link>https://example.com/${item.guid}</link>
      <guid isPermaLink="false">${item.guid}</guid>
      <pubDate>${item.pubDate.toUTCString()}</pubDate>
      <description>Body of ${item.title}</description>
    </item>`
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <description>A feed for the fetch_feed handler tests</description>
${body}
  </channel>
</rss>`;
}

/**
 * Creates a feed pointing at the loopback origin. `lastFetchedAt` defaults to
 * null — a feed nobody has fetched yet — because that is what disables the
 * backfill guard, and tests that want it active set it explicitly.
 */
async function createLoopbackFeed(overrides: Partial<typeof feeds.$inferInsert> = {}) {
  const feedId = await createTestFeed({ url: `${baseUrl}/feed.xml`, ...overrides });
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId));
  return feed;
}

async function readFeed(feedId: string) {
  const [feed] = await db.select().from(feeds).where(eq(feeds.id, feedId));
  return feed;
}

async function readUserEntries(userId: string) {
  return db
    .select({ guid: entries.guid, read: userEntries.read, title: entries.title })
    .from(userEntries)
    .innerJoin(entries, eq(entries.id, userEntries.entryId))
    .where(eq(userEntries.userId, userId));
}

beforeAll(async () => {
  server = createServer((req, res) => {
    receivedHeaders.push(req.headers);
    const { status = 200, body = "", headers = {} } = nextResponse;
    res.writeHead(status, { "Content-Type": "application/rss+xml; charset=utf-8", ...headers });
    res.end(status === 304 ? undefined : body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
  receivedHeaders = [];
  nextResponse = { body: rss([]) };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
});

describe("handleFetchFeed", () => {
  describe("preconditions", () => {
    it("reports a missing feed without throwing, and retries in an hour", async () => {
      const before = Date.now();
      const result = await handleFetchFeed({ feedId: "00000000-0000-7000-8000-000000000000" });

      expect(result.success).toBe(false);
      expect(result.error).toContain("Feed not found");
      expect(result.nextRunAt!.getTime()).toBeGreaterThan(before + 59 * 60 * 1000);
    });

    it("parks a feed with no URL rather than retrying it hourly", async () => {
      // Email feeds have no URL and can never be fetched, so a tight retry loop
      // would just burn worker cycles forever.
      const before = Date.now();
      const ownerId = await createTestUser({ emailPrefix: "ff-nourl" });
      const feedId = await createTestFeed({
        type: "email",
        url: null,
        userId: ownerId,
        emailSenderPattern: "sender@example.com",
      });

      const result = await handleFetchFeed({ feedId });

      expect(result.success).toBe(false);
      expect(result.error).toContain("no URL");
      expect(result.nextRunAt!.getTime()).toBeGreaterThan(before + 6 * 24 * 60 * 60 * 1000);
      expect(receivedHeaders).toHaveLength(0);
    });
  });

  describe("first fetch", () => {
    it("stores entries, fans them out unread, and records the fetch on the feed", async () => {
      const feed = await createLoopbackFeed();
      const userId = await createTestUser({ emailPrefix: "ff-first" });
      const subscriptionId = await createTestSubscription(userId, feed.id);

      nextResponse = {
        body: rss([
          { guid: "a", title: "Article A", pubDate: new Date(Date.now() - 60_000) },
          { guid: "b", title: "Article B", pubDate: new Date(Date.now() - 120_000) },
        ]),
        headers: { ETag: '"v1"', "Last-Modified": new Date().toUTCString() },
      };

      const result = await handleFetchFeed({ feedId: feed.id });

      expect(result.success).toBe(true);
      expect(result.metadata).toMatchObject({ newEntries: 2, backfilledEntries: 0 });

      const rows = await readUserEntries(userId);
      expect(rows).toHaveLength(2);
      expect(rows.every((r) => r.read === false)).toBe(true);

      const [subscription] = await db
        .select({ unreadCount: subscriptions.unreadCount })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId));
      expect(subscription.unreadCount).toBe(2);

      // The feed row now carries everything the next poll conditions on.
      const after = await readFeed(feed.id);
      expect(after.lastFetchedAt).not.toBeNull();
      expect(after.lastEntriesUpdatedAt).not.toBeNull();
      expect(after.bodyHash).not.toBeNull();
      expect(after.etag).toBe('"v1"');
      expect(after.consecutiveFailures).toBe(0);
      expect(after.lastError).toBeNull();
      expect(after.lastFetchEntryCount).toBe(2);
    });

    it("keeps years-old entries unread, because we were never watching (#1500)", async () => {
      // The backfill guard reads `feeds.last_fetched_at` as of *before* this
      // fetch. On a first fetch there is none, so nothing this feed lists can be
      // an archive re-announcement — a brand-new subscription to an archive of
      // old posts must still deliver them unread.
      const feed = await createLoopbackFeed();
      const userId = await createTestUser({ emailPrefix: "ff-firstold" });
      await createTestSubscription(userId, feed.id);

      nextResponse = {
        body: rss([{ guid: "old", title: "From 2019", pubDate: new Date("2019-05-01T00:00:00Z") }]),
      };

      const result = await handleFetchFeed({ feedId: feed.id });

      expect(result.metadata).toMatchObject({ newEntries: 1, backfilledEntries: 0 });
      const rows = await readUserEntries(userId);
      expect(rows).toHaveLength(1);
      expect(rows[0].read).toBe(false);
    });

    it("sends our User-Agent with the subscriber count", async () => {
      const feed = await createLoopbackFeed();
      const userId = await createTestUser({ emailPrefix: "ff-ua" });
      await createTestSubscription(userId, feed.id);

      await handleFetchFeed({ feedId: feed.id });

      const userAgent = receivedHeaders[0]["user-agent"];
      expect(userAgent).toContain("LionReader");
      expect(userAgent).toContain("1 subscriber");
    });
  });

  describe("archive re-announcement (#1500)", () => {
    it("delivers an old first sighting read and a fresh one unread", async () => {
      // The #1500 shape, end to end: a feed we have been polling suddenly lists
      // an article published years before our previous poll. It is stored and
      // made visible, but it isn't news, so it must not reach an unread badge —
      // while the genuinely new article in the same fetch must.
      const lastPoll = new Date(Date.now() - 60 * 60 * 1000);
      const feed = await createLoopbackFeed({
        lastFetchedAt: lastPoll,
        lastEntriesUpdatedAt: lastPoll,
      });
      const userId = await createTestUser({ emailPrefix: "ff-backfill" });
      const subscriptionId = await createTestSubscription(userId, feed.id);

      nextResponse = {
        body: rss([
          { guid: "fresh", title: "Today's post", pubDate: new Date(Date.now() - 60_000) },
          { guid: "archive", title: "Ukraine Post #5", pubDate: new Date("2022-03-01T00:00:00Z") },
        ]),
      };

      const result = await handleFetchFeed({ feedId: feed.id });

      expect(result.metadata).toMatchObject({ newEntries: 2, backfilledEntries: 1 });

      const rows = await readUserEntries(userId);
      expect(rows.find((r) => r.guid === "fresh")?.read).toBe(false);
      expect(rows.find((r) => r.guid === "archive")?.read).toBe(true);

      const [subscription] = await db
        .select({ unreadCount: subscriptions.unreadCount })
        .from(subscriptions)
        .where(eq(subscriptions.id, subscriptionId));
      expect(subscription.unreadCount).toBe(1);
    });

    it("keeps everything unread on a forced subscribe-time refresh", async () => {
      // `forceReprocess` exists to hand a brand-new subscriber the current feed
      // as ground truth. That subscriber has no history to judge "already old
      // when we last looked" against, so the guard is suppressed and the
      // stale-feed subscribe path delivers what the fresh-feed one would.
      const lastPoll = new Date(Date.now() - 60 * 60 * 1000);
      const feed = await createLoopbackFeed({
        lastFetchedAt: lastPoll,
        lastEntriesUpdatedAt: lastPoll,
      });
      const userId = await createTestUser({ emailPrefix: "ff-forced" });
      await createTestSubscription(userId, feed.id);

      nextResponse = {
        body: rss([{ guid: "old", title: "From 2022", pubDate: new Date("2022-03-01T00:00:00Z") }]),
      };

      const result = await handleFetchFeed({ feedId: feed.id }, { forceReprocess: true });

      expect(result.metadata).toMatchObject({ newEntries: 1, backfilledEntries: 0 });
      const rows = await readUserEntries(userId);
      expect(rows[0].read).toBe(false);
    });
  });

  describe("conditional GET", () => {
    it("sends the stored validators and treats 304 as no change", async () => {
      const lastModified = new Date(Date.now() - 60 * 60 * 1000).toUTCString();
      const feed = await createLoopbackFeed({
        etag: '"stored-etag"',
        lastModifiedHeader: lastModified,
      });
      const userId = await createTestUser({ emailPrefix: "ff-304" });
      await createTestSubscription(userId, feed.id);

      nextResponse = { status: 304 };

      const result = await handleFetchFeed({ feedId: feed.id });

      expect(receivedHeaders[0]["if-none-match"]).toBe('"stored-etag"');
      expect(receivedHeaders[0]["if-modified-since"]).toBe(lastModified);
      expect(result.success).toBe(true);
      expect(result.metadata).toMatchObject({ notModified: true });

      // Nothing was parsed, so no entries and no generation change...
      expect(await db.select().from(entries).where(eq(entries.feedId, feed.id))).toHaveLength(0);
      const after = await readFeed(feed.id);
      expect(after.lastEntriesUpdatedAt).toBeNull();
      // ...but the poll still counts as a successful fetch.
      expect(after.lastFetchedAt).not.toBeNull();
      expect(after.consecutiveFailures).toBe(0);
    });

    it("omits the validators on a forced refresh, so a 304 can't starve it", async () => {
      // A 304 carries no body, and a forced refresh needs the full current feed
      // to re-establish visibility from.
      const feed = await createLoopbackFeed({
        etag: '"stored-etag"',
        lastModifiedHeader: new Date().toUTCString(),
      });

      nextResponse = { body: rss([{ guid: "a", title: "A", pubDate: new Date() }]) };

      await handleFetchFeed({ feedId: feed.id }, { forceReprocess: true });

      expect(receivedHeaders[0]["if-none-match"]).toBeUndefined();
      expect(receivedHeaders[0]["if-modified-since"]).toBeUndefined();
    });
  });

  describe("body-hash short circuit", () => {
    it("skips re-processing when the body is byte-identical", async () => {
      const feed = await createLoopbackFeed();
      const userId = await createTestUser({ emailPrefix: "ff-hash" });
      await createTestSubscription(userId, feed.id);

      nextResponse = { body: rss([{ guid: "a", title: "A", pubDate: new Date() }]) };
      const first = await handleFetchFeed({ feedId: feed.id });
      expect(first.metadata).toMatchObject({ newEntries: 1 });
      const generation = (await readFeed(feed.id)).lastEntriesUpdatedAt;

      // Same bytes, and no ETag/Last-Modified for the server to 304 on, so the
      // body hash is the only thing that can stop a full re-parse.
      const second = await handleFetchFeed({ feedId: feed.id });

      expect(second.success).toBe(true);
      expect(second.metadata).toMatchObject({ bodyUnchanged: true });
      expect(second.metadata).not.toHaveProperty("newEntries");
      // The visibility generation is untouched, so nothing churns for subscribers.
      expect((await readFeed(feed.id)).lastEntriesUpdatedAt?.toISOString()).toBe(
        generation?.toISOString()
      );
      expect(await readUserEntries(userId)).toHaveLength(1);
    });

    it("re-processes an identical body on a forced refresh", async () => {
      // A byte-identical body can still need reconciling: a WebSub push may have
      // desynced last_seen_at, or an entry may need dropping from the generation.
      const feed = await createLoopbackFeed();
      nextResponse = { body: rss([{ guid: "a", title: "A", pubDate: new Date() }]) };
      await handleFetchFeed({ feedId: feed.id });

      const second = await handleFetchFeed({ feedId: feed.id }, { forceReprocess: true });

      expect(second.metadata).not.toHaveProperty("bodyUnchanged");
      expect(second.metadata).toMatchObject({ newEntries: 0, unchangedEntries: 1 });
    });
  });

  describe("failures", () => {
    it("backs off on a 404 instead of parking the feed for a week (#1114)", async () => {
      // A single 404 is not proof the feed is gone — YouTube 404s all its feeds
      // for hours most days — so the ordinary backoff ladder applies.
      const feed = await createLoopbackFeed();
      nextResponse = { status: 404, body: "nope" };

      const before = Date.now();
      const result = await handleFetchFeed({ feedId: feed.id });

      expect(result.success).toBe(false);
      const after = await readFeed(feed.id);
      expect(after.consecutiveFailures).toBe(1);
      expect(after.lastError).not.toBeNull();
      expect(after.nextFetchAt!.getTime()).toBeGreaterThan(before);
      expect(after.nextFetchAt!.getTime()).toBeLessThan(before + 7 * 24 * 60 * 60 * 1000);
    });

    it("compounds the backoff across consecutive failures", async () => {
      const feed = await createLoopbackFeed({ consecutiveFailures: 3 });
      nextResponse = { status: 500, body: "boom" };

      await handleFetchFeed({ feedId: feed.id });

      const after = await readFeed(feed.id);
      expect(after.consecutiveFailures).toBe(4);
    });

    it("resets the failure count and error after a success", async () => {
      const feed = await createLoopbackFeed({
        consecutiveFailures: 4,
        lastError: "previous failure",
      });
      nextResponse = { body: rss([{ guid: "a", title: "A", pubDate: new Date() }]) };

      const result = await handleFetchFeed({ feedId: feed.id });

      expect(result.success).toBe(true);
      const after = await readFeed(feed.id);
      expect(after.consecutiveFailures).toBe(0);
      expect(after.lastError).toBeNull();
    });

    it("counts an unparseable body as a failure and leaves entries alone", async () => {
      const feed = await createLoopbackFeed();
      const userId = await createTestUser({ emailPrefix: "ff-garbage" });
      await createTestSubscription(userId, feed.id);

      nextResponse = { body: "this is not a feed" };

      const result = await handleFetchFeed({ feedId: feed.id });

      expect(result.success).toBe(false);
      expect(await readUserEntries(userId)).toHaveLength(0);
      expect((await readFeed(feed.id)).consecutiveFailures).toBe(1);
    });
  });
});
