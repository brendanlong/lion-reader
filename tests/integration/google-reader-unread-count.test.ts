/**
 * Integration tests for `getGreaderNewestItemAt` — the per-feed "newest visible
 * item" lookup that powers the Google Reader unread-count endpoint's
 * `newestItemTimestampUsec`.
 *
 * The value must be the newest entry the user can actually see (has a
 * `user_entries` row for), INCLUDING read entries, and must include the synthetic
 * saved feed keyed by its feed id. These are real-DB concerns (the visibility
 * join and the read-inclusive max), so they're verified against Postgres here
 * rather than in the pure formatting unit test.
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  userEntries,
  subscriptions,
  subscriptionFeeds,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { getGreaderNewestItemAt } from "../../src/server/google-reader/subscriptions";

const createdUserIds: string[] = [];

afterAll(async () => {
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

async function createSubscribedFeed(userId: string): Promise<{ feedId: string; subId: string }> {
  const feedId = generateUuidv7();
  const subId = generateUuidv7();
  const now = new Date();
  await db
    .insert(feeds)
    .values({
      id: feedId,
      type: "web",
      url: `https://f/${feedId}`,
      createdAt: now,
      updatedAt: now,
    });
  await db
    .insert(subscriptions)
    .values({ id: subId, userId, feedId, subscribedAt: now, createdAt: now, updatedAt: now });
  await db.insert(subscriptionFeeds).values({ subscriptionId: subId, feedId, userId });
  return { feedId, subId };
}

async function createSavedFeed(userId: string): Promise<string> {
  const feedId = generateUuidv7();
  const now = new Date();
  await db
    .insert(feeds)
    .values({ id: feedId, type: "saved", userId, createdAt: now, updatedAt: now });
  return feedId;
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
    await db.insert(userEntries).values({
      userId: opts.userId,
      entryId,
      read: opts.read,
      publishedOrFetchedAt: opts.publishedAt ?? opts.fetchedAt,
    });
  }
}

const T = (iso: string): Date => new Date(iso);

describe("getGreaderNewestItemAt", () => {
  it("returns the newest visible entry per subscription, counting read entries", async () => {
    const userId = await createUser();
    const { feedId, subId } = await createSubscribedFeed(userId);

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

    const map = await getGreaderNewestItemAt(db, userId);
    expect(map.get(subId)?.toISOString()).toBe("2026-05-01T00:00:00.000Z");
  });

  it("ignores entries the user has no user_entries row for (privacy gating)", async () => {
    const userId = await createUser();
    const { feedId, subId } = await createSubscribedFeed(userId);

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

    const map = await getGreaderNewestItemAt(db, userId);
    expect(map.get(subId)?.toISOString()).toBe("2026-02-01T00:00:00.000Z");
  });

  it("uses COALESCE(published_at, fetched_at) — fetched_at when published_at is null", async () => {
    const userId = await createUser();
    const { feedId, subId } = await createSubscribedFeed(userId);
    await addEntry({
      userId,
      feedId,
      type: "web",
      publishedAt: null,
      fetchedAt: T("2026-06-15T10:00:00Z"),
      read: false,
      withUserEntry: true,
    });

    const map = await getGreaderNewestItemAt(db, userId);
    expect(map.get(subId)?.toISOString()).toBe("2026-06-15T10:00:00.000Z");
  });

  it("includes the saved feed keyed by its feed id", async () => {
    const userId = await createUser();
    const savedFeedId = await createSavedFeed(userId);
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

    const map = await getGreaderNewestItemAt(db, userId);
    expect(map.get(savedFeedId)?.toISOString()).toBe("2026-07-07T07:07:00.000Z");
  });

  it("omits a subscription with no visible entries", async () => {
    const userId = await createUser();
    const { subId } = await createSubscribedFeed(userId);
    // No entries / user_entries at all.
    const map = await getGreaderNewestItemAt(db, userId);
    expect(map.has(subId)).toBe(false);
  });

  it("does not leak newest times across users", async () => {
    const userA = await createUser();
    const userB = await createUser();
    const { feedId, subId } = await createSubscribedFeed(userA);
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

    const mapA = await getGreaderNewestItemAt(db, userA);
    expect(mapA.has(subId)).toBe(false);
  });
});
