/**
 * Integration tests for WebSub content-notification ingest.
 *
 * `ingestWebsubNotification` is the path a hub push takes into the entry
 * pipeline. It never throws — it reports an outcome the callback route turns
 * into a status code — which makes wrong behaviour easy to miss; these tests pin
 * the parts that reach subscribers.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  entries,
  feeds,
  jobs,
  subscriptions,
  userEntries,
  users,
  websubHubStats,
} from "../../src/server/db/schema";
import { ingestWebsubNotification } from "../../src/server/feed/websub-notification";
import {
  claimFullContentJob,
  getJobPayload,
  MAX_RUNNING_FULL_CONTENT_JOBS,
} from "../../src/server/jobs/queue";
import { handleFetchFullContent } from "../../src/server/jobs/handlers/fetch-full-content";
import { createTestFeed, createTestSubscription, createTestUser } from "./helpers";

const HUB_URL = "https://hub.example.com/";

/** A one-item RSS document, the shape a hub pushes for a single post. */
function pushBody(
  guid: string,
  title: string,
  pubDate: Date,
  link = `https://example.com/${guid}`
): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
    <item>
      <title>${title}</title>
      <link>${link}</link>
      <guid isPermaLink="false">${guid}</guid>
      <pubDate>${pubDate.toUTCString()}</pubDate>
      <description>Body of ${title}</description>
    </item>
  </channel>
</rss>`;
}

/** A push carrying `count` new posts, each linking to the loopback origin. */
function multiPushBody(prefix: string, count: number, pubDate: Date): string {
  const items = Array.from(
    { length: count },
    (_, i) => `    <item>
      <title>Post ${i}</title>
      <link>${articleBaseUrl}/post/${prefix}-${i}</link>
      <guid isPermaLink="false">${prefix}-${i}</guid>
      <pubDate>${pubDate.toUTCString()}</pubDate>
      <description>Summary ${i}</description>
    </item>`
  ).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Feed</title>
    <link>https://example.com</link>
${items}
  </channel>
</rss>`;
}

async function queuedFullContentJobs() {
  return db.select().from(jobs).where(eq(jobs.type, "fetch_full_content"));
}

async function seedPushFeed(
  emailPrefix: string,
  lastPoll: Date,
  subscriptionOverrides: Partial<typeof subscriptions.$inferInsert> = {}
) {
  const feedId = await createTestFeed({
    url: `https://example.com/${emailPrefix}.xml`,
    hubUrl: HUB_URL,
    websubActive: true,
    lastFetchedAt: lastPoll,
    lastEntriesUpdatedAt: lastPoll,
  });
  const userId = await createTestUser({ emailPrefix });
  const subscriptionId = await createTestSubscription(userId, feedId, subscriptionOverrides);
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

/** The article page a pushed entry links to, served by the loopback origin. */
const ARTICLE_HTML = `<!DOCTYPE html>
<html><head><title>The Whole Story</title></head>
<body>
  <nav>Home | About</nav>
  <article>
    <h1>The Whole Story</h1>
    ${Array.from(
      { length: 6 },
      (_, i) =>
        `<p>Paragraph ${i + 1} of the complete article, which the feed only summarized. It carries enough prose that extraction treats it as the real content of the page.</p>`
    ).join("\n    ")}
  </article>
  <footer>Copyright</footer>
</body></html>`;

let articleServer: Server;
let articleBaseUrl: string;
/** Paths the loopback origin was asked for, in order. */
let articleRequests: string[];

beforeAll(async () => {
  articleServer = createServer((req, res) => {
    articleRequests.push(req.url ?? "/");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ARTICLE_HTML);
  });
  await new Promise<void>((resolve) => articleServer.listen(0, "127.0.0.1", resolve));
  articleBaseUrl = `http://127.0.0.1:${(articleServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => articleServer.close(() => resolve()));
});

describe("ingestWebsubNotification", () => {
  async function cleanup(): Promise<void> {
    await db.delete(jobs).where(eq(jobs.type, "fetch_full_content"));
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(websubHubStats);
    await db.delete(feeds);
    await db.delete(users);
  }

  beforeEach(async () => {
    await cleanup();
    articleRequests = [];
  });
  afterAll(cleanup);

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

  it("fetches full content for a pushed entry on a full-content subscription, off the request", async () => {
    // A poll fetches full content only for entries that are new to *it*, and a
    // pushed entry isn't by the time the backup poll comes round, so the push has
    // to arrange it — without making the hub's callback wait on the article.
    const now = Date.now();
    const { feed, userId } = await seedPushFeed("pushfull", new Date(now - 60 * 60 * 1000), {
      fetchFullContent: true,
    });

    const outcome = await ingestWebsubNotification(
      feed,
      pushBody("full-1", "Summary only", new Date(now - 60 * 1000), `${articleBaseUrl}/post/full-1`)
    );
    expect(outcome).toBe("processed");

    // The push itself never touched the article: it queued a job for it.
    expect(articleRequests).toEqual([]);
    const [pushed] = await db.select().from(entries).where(eq(entries.feedId, feed.id));
    expect(pushed.fullContentFetchedAt).toBeNull();

    // Run the queued job the way the worker does.
    const job = await claimFullContentJob();
    expect(job).not.toBeNull();
    const payload = getJobPayload<"fetch_full_content">(job!);
    expect(payload).toEqual({ feedId: feed.id, entryIds: [pushed.id] });
    const result = await handleFetchFullContent(payload, job!.consecutiveFailures);
    expect(result.success).toBe(true);
    expect(result.metadata).toMatchObject({ fullContentFetched: 1, fullContentFailed: 0 });

    expect(articleRequests).toEqual(["/post/full-1"]);
    const [entry] = await db.select().from(entries).where(eq(entries.id, pushed.id));
    expect(entry.fullContentError).toBeNull();
    expect(entry.fullContentFetchedAt).not.toBeNull();
    expect(entry.fullContentCleaned).toContain("Paragraph 6 of the complete article");
    expect(entry.fullContentCleaned).not.toContain("Copyright");
    // The entry reached the subscriber as usual.
    expect((await getUserEntry(userId)).guid).toBe("full-1");
  });

  it("splits a large push across jobs rather than dropping entries, and a rerun skips finished ones", async () => {
    const now = Date.now();
    const { feed } = await seedPushFeed("pushmany", new Date(now - 60 * 60 * 1000), {
      fetchFullContent: true,
    });

    await ingestWebsubNotification(feed, multiPushBody("many", 12, new Date(now - 60 * 1000)));

    const queued = await queuedFullContentJobs();
    const sizes = queued
      .map((j) => getJobPayload<"fetch_full_content">(j).entryIds.length)
      .sort((a, b) => b - a);
    expect(sizes).toEqual([10, 2]);
    const allIds = queued.flatMap((j) => getJobPayload<"fetch_full_content">(j).entryIds);
    expect(new Set(allIds).size).toBe(12);

    const small = queued.find((j) => getJobPayload<"fetch_full_content">(j).entryIds.length === 2)!;
    const smallPayload = getJobPayload<"fetch_full_content">(small);
    expect((await handleFetchFullContent(smallPayload, 0)).metadata).toMatchObject({
      fullContentFetched: 2,
    });
    expect(articleRequests).toHaveLength(2);

    // A retry of the same job (say it threw after finishing its fetches) doesn't
    // fetch those articles again.
    expect((await handleFetchFullContent(smallPayload, 1)).metadata).toMatchObject({
      fullContentFetched: 0,
      fullContentFailed: 0,
    });
    expect(articleRequests).toHaveLength(2);
  });

  it("gives up and parks a job that has already failed too often", async () => {
    const now = Date.now();
    const { feed } = await seedPushFeed("pushgiveup", new Date(now - 60 * 60 * 1000), {
      fetchFullContent: true,
    });
    await ingestWebsubNotification(
      feed,
      pushBody("giveup-1", "Post", new Date(now - 60 * 1000), `${articleBaseUrl}/post/giveup-1`)
    );
    const [queued] = await queuedFullContentJobs();

    const result = await handleFetchFullContent(getJobPayload<"fetch_full_content">(queued), 3);
    expect(result.success).toBe(false);
    // Parked: far enough out for the retention sweep to treat it as finished.
    expect(result.nextRunAt.getTime()).toBeGreaterThan(now + 180 * 24 * 60 * 60 * 1000);
    expect(articleRequests).toEqual([]);
  });

  it("caps how many full-content jobs run at once", async () => {
    const now = Date.now();
    const { feed } = await seedPushFeed("pushcap", new Date(now - 60 * 60 * 1000), {
      fetchFullContent: true,
    });
    for (let i = 0; i <= MAX_RUNNING_FULL_CONTENT_JOBS; i++) {
      await ingestWebsubNotification(
        feed,
        pushBody(
          `cap-${i}`,
          `Post ${i}`,
          new Date(now - 60 * 1000),
          `${articleBaseUrl}/post/cap-${i}`
        )
      );
    }
    expect(await queuedFullContentJobs()).toHaveLength(MAX_RUNNING_FULL_CONTENT_JOBS + 1);

    for (let i = 0; i < MAX_RUNNING_FULL_CONTENT_JOBS; i++) {
      expect(await claimFullContentJob()).not.toBeNull();
    }
    // One is still due, but the running ones hold every allowed slot.
    expect(await claimFullContentJob()).toBeNull();
  });

  it("queues no full-content work when no subscriber wants it", async () => {
    const now = Date.now();
    const { feed } = await seedPushFeed("pushnofull", new Date(now - 60 * 60 * 1000));

    await ingestWebsubNotification(
      feed,
      pushBody(
        "plain-1",
        "Summary only",
        new Date(now - 60 * 1000),
        `${articleBaseUrl}/post/plain-1`
      )
    );

    expect(await queuedFullContentJobs()).toEqual([]);
    expect(articleRequests).toEqual([]);
  });

  it("queues no full-content work for an archive replay", async () => {
    // Same rule as the poll path: re-announced history isn't news and mustn't
    // spend the full-content budget.
    const { feed } = await seedPushFeed("pushfullarchive", new Date(Date.now() - 60 * 60 * 1000), {
      fetchFullContent: true,
    });

    await ingestWebsubNotification(
      feed,
      pushBody(
        "archive-full-1",
        "Old post",
        new Date("2022-03-01T00:00:00Z"),
        `${articleBaseUrl}/post/archive-full-1`
      )
    );

    expect(await queuedFullContentJobs()).toEqual([]);
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
