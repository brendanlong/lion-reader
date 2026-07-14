/**
 * Integration tests for `getGreaderUnreadCounts` — the single-query per-feed
 * "unread count + newest visible item" lookup that powers the Google Reader
 * unread-count endpoint (`newestItemTimestampUsec`).
 *
 * The newest value must be the newest entry the user can actually see (has a
 * `user_entries` row for), INCLUDING read entries, and the result must include the
 * synthetic saved feed keyed by its stream serial. Deriving the count and the newest from
 * one statement also means they can never disagree about whether a feed has content
 * (issue #1092). These are real-DB concerns (the visibility join, the read-inclusive
 * max, the shared snapshot), so they're verified against Postgres here rather than
 * in the pure formatting unit test.
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, entries, userEntries, subscriptions } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { getGreaderUnreadCounts } from "../../src/server/google-reader/subscriptions";

/**
 * Newest-item map for a user, extracted from the combined unread-counts result.
 * Keyed by the Google Reader feed stream serial (issue #1117), which Postgres
 * hands back as a decimal string.
 */
async function getNewest(userId: string): Promise<Map<string, Date>> {
  return (await getGreaderUnreadCounts(db, userId)).newestItemAtByStreamId;
}

const createdUserIds: string[] = [];
const createdFeedIds: string[] = [];

afterAll(async () => {
  // Web feeds carry no user_id, so they don't cascade from `users`; delete them
  // explicitly (their `entries` cascade from `feeds`). Saved feeds would cascade
  // from the user, but deleting them here too is harmless.
  if (createdFeedIds.length > 0) {
    await db.delete(feeds).where(inArray(feeds.id, createdFeedIds));
  }
  if (createdUserIds.length > 0) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

async function createUser(): Promise<string> {
  const id = generateUuidv7();
  await db.insert(users).values({
    id,
    email: `newest-${id}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(id);
  return id;
}

async function createSubscribedFeed(
  userId: string
): Promise<{ feedId: string; subId: string; streamId: string }> {
  const feedId = generateUuidv7();
  const subId = generateUuidv7();
  const now = new Date();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url: `https://f/${feedId}`,
    createdAt: now,
    updatedAt: now,
  });
  const [sub] = await db
    .insert(subscriptions)
    .values({ id: subId, userId, feedId, subscribedAt: now, createdAt: now, updatedAt: now })
    .returning({ greaderStreamId: subscriptions.greaderStreamId });
  createdFeedIds.push(feedId);
  return { feedId, subId, streamId: sub.greaderStreamId.toString() };
}

async function createSavedFeed(userId: string): Promise<{ feedId: string; streamId: string }> {
  const feedId = generateUuidv7();
  const now = new Date();
  const [feed] = await db
    .insert(feeds)
    .values({ id: feedId, type: "saved", userId, createdAt: now, updatedAt: now })
    .returning({ greaderStreamId: feeds.greaderStreamId });
  createdFeedIds.push(feedId);
  return { feedId, streamId: feed.greaderStreamId.toString() };
}

/** Inserts an entry and (optionally) the user's user_entries row for it. */
async function addEntry(opts: {
  userId: string;
  feedId: string;
  type: "web" | "saved";
  publishedAt: Date | null;
  fetchedAt: Date;
  read: boolean;
  withUserEntry: boolean;
}): Promise<void> {
  const entryId = generateUuidv7();
  await db.insert(entries).values({
    id: entryId,
    feedId: opts.feedId,
    type: opts.type,
    guid: `guid-${entryId}`,
    contentHash: `hash-${entryId}`,
    publishedAt: opts.publishedAt,
    fetchedAt: opts.fetchedAt,
    lastSeenAt: opts.type === "web" ? opts.fetchedAt : null,
    createdAt: opts.fetchedAt,
    updatedAt: opts.fetchedAt,
  });
  if (opts.withUserEntry) {
    // publishedOrFetchedAt is filled by the user_entries_fill_denormalized
    // trigger (COALESCE(published_at, fetched_at)).
    await db.insert(userEntries).values({
      userId: opts.userId,
      entryId,
      read: opts.read,
    });
  }
}

const T = (iso: string): Date => new Date(iso);

describe("getGreaderUnreadCounts", () => {
  it("returns the newest visible entry per subscription, counting read entries", async () => {
    const userId = await createUser();
    const { feedId, streamId } = await createSubscribedFeed(userId);

    // Older unread entry, and a NEWER but already-read entry. The read one is the
    // newest item in the stream, so it must win (read state is ignored).
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: T("2026-01-01T00:00:00Z"),
      fetchedAt: T("2026-01-01T00:00:00Z"),
      read: false,
      withUserEntry: true,
    });
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: T("2026-05-01T00:00:00Z"),
      fetchedAt: T("2026-05-01T00:00:00Z"),
      read: true,
      withUserEntry: true,
    });

    const map = await getNewest(userId);
    expect(map.get(streamId)?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("ignores entries the user has no user_entries row for (privacy gating)", async () => {
    const userId = await createUser();
    const { feedId, streamId } = await createSubscribedFeed(userId);

    // The newest entry in the feed predates the user and has NO user_entries row,
    // so it must not count; the newest VISIBLE entry is the older one.
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: T("2026-02-01T00:00:00Z"),
      fetchedAt: T("2026-02-01T00:00:00Z"),
      read: false,
      withUserEntry: true,
    });
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: T("2026-09-09T00:00:00Z"),
      fetchedAt: T("2026-09-09T00:00:00Z"),
      read: false,
      withUserEntry: false,
    });

    const map = await getNewest(userId);
    expect(map.get(streamId)?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("uses COALESCE(published_at, fetched_at) — fetched_at when published_at is null", async () => {
    const userId = await createUser();
    const { feedId, streamId } = await createSubscribedFeed(userId);
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: null,
      fetchedAt: T("2026-06-15T10:00:00Z"),
      read: false,
      withUserEntry: true,
    });

    const map = await getNewest(userId);
    expect(map.get(streamId)?.toISOString()).toBe("2026-06-15T10:00:00.000Z");
  });

  it("includes the saved feed keyed by its stream serial", async () => {
    const userId = await createUser();
    const { feedId: savedFeedId, streamId } = await createSavedFeed(userId);
    await addEntry({
      userId,
      feedId: savedFeedId,
      type: "saved",
      publishedAt: null,
      fetchedAt: T("2026-03-03T03:03:00Z"),
      read: true,
      withUserEntry: true,
    });
    await addEntry({
      userId,
      feedId: savedFeedId,
      type: "saved",
      publishedAt: null,
      fetchedAt: T("2026-07-07T07:07:00Z"),
      read: false,
      withUserEntry: true,
    });

    const map = await getNewest(userId);
    expect(map.get(streamId)?.toISOString()).toBe("2026-07-07T07:07:00.000Z");
  });

  it("omits a subscription with no visible entries", async () => {
    const userId = await createUser();
    const { streamId } = await createSubscribedFeed(userId);
    // No entries / user_entries at all.
    const map = await getNewest(userId);
    expect(map.has(streamId)).toBe(false);
  });

  // Regression for issue #1092: the endpoint used to read the per-feed counts and
  // the newest-item times separately, so a feed gaining its first visible entry
  // between the reads could be counted (unread > 0) yet be absent from the newest
  // map. `getGreaderUnreadCounts` derives both from one statement, so a feed's
  // count and newest come from a single snapshot and can never disagree: whenever
  // the count is > 0 there is a newest entry, and both reflect the same entry.
  it("returns count and newest for the same feed from one snapshot (issue #1092)", async () => {
    const userId = await createUser();
    const { feedId, streamId } = await createSubscribedFeed(userId);
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: T("2026-10-10T00:00:00Z"),
      fetchedAt: T("2026-10-10T00:00:00Z"),
      read: false,
      withUserEntry: true,
    });

    const { subscriptions, newestItemAtByStreamId } = await getGreaderUnreadCounts(db, userId);
    const sub = subscriptions.find((s) => s.streamId === streamId);
    // The count is > 0 and the newest map has this feed — the pair a client relies
    // on to decide a stream has new content, guaranteed consistent by the single
    // query. (Two independent reads could have returned the count without the map.)
    expect(sub?.unreadCount).toBe(1);
    expect(newestItemAtByStreamId.get(streamId)?.toISOString()).toBe("2026-10-10T00:00:00.000Z");
  });

  it("reports the trigger-maintained unread count, excluding read entries", async () => {
    const userId = await createUser();
    const { feedId, streamId } = await createSubscribedFeed(userId);
    // Two unread + one read entry → count is 2, matching subscriptions.unread_count.
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: T("2026-04-01T00:00:00Z"),
      fetchedAt: T("2026-04-01T00:00:00Z"),
      read: false,
      withUserEntry: true,
    });
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: T("2026-04-02T00:00:00Z"),
      fetchedAt: T("2026-04-02T00:00:00Z"),
      read: false,
      withUserEntry: true,
    });
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: T("2026-04-03T00:00:00Z"),
      fetchedAt: T("2026-04-03T00:00:00Z"),
      read: true,
      withUserEntry: true,
    });

    const { subscriptions } = await getGreaderUnreadCounts(db, userId);
    expect(subscriptions.find((s) => s.streamId === streamId)?.unreadCount).toBe(2);
  });

  it("reports the saved feed count from users.saved_unread_count", async () => {
    const userId = await createUser();
    const { feedId: savedFeedId, streamId } = await createSavedFeed(userId);
    await addEntry({
      userId,
      feedId: savedFeedId,
      type: "saved",
      publishedAt: null,
      fetchedAt: T("2026-05-05T05:05:00Z"),
      read: false,
      withUserEntry: true,
    });

    const { subscriptions } = await getGreaderUnreadCounts(db, userId);
    expect(subscriptions.find((s) => s.streamId === streamId)?.unreadCount).toBe(1);
  });

  it("does not leak newest times across users", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const { feedId, streamId } = await createSubscribedFeed(userA);
    // Entry exists in the feed and userB somehow has a row, but userA has none for it.
    await addEntry({
      userId: userB,
      feedId,
      type: "web",
      publishedAt: T("2026-08-08T00:00:00Z"),
      fetchedAt: T("2026-08-08T00:00:00Z"),
      read: false,
      withUserEntry: true,
    });

    const mapA = await getNewest(userA);
    expect(mapA.has(streamId)).toBe(false);
  });
});
