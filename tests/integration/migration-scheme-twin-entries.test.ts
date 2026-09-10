/**
 * Integration tests for migration 0109 (issue #1535): merging web entries whose
 * guids differ only by http/https scheme, and the unique index that then
 * forbids new twins.
 *
 * Migrations already ran against the test database, so the merge is exercised
 * by replaying the migration file's statements over seeded twins with the
 * unique index temporarily dropped, then recreating the index from the same
 * file. The file layout the test relies on: the CREATE UNIQUE INDEX is the last
 * statement and everything before it is the merge.
 */

import { readFileSync } from "fs";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds, subscriptions, userEntries, users } from "../../src/server/db/schema";
import { createTestEntry, createTestFeed, createTestSubscription, createTestUser } from "./helpers";

const INDEX_NAME = "uq_entries_feed_guid_canonical";

const migrationStatements = readFileSync(
  new URL("../../migrations/0109_merge_scheme_twin_entries.sql", import.meta.url),
  "utf8"
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

const createIndexStatement = migrationStatements[migrationStatements.length - 1];
const mergeStatements = migrationStatements.slice(0, -1);

async function runMerge() {
  await db.transaction(async (tx) => {
    for (const statement of mergeStatements) {
      await tx.execute(sql.raw(statement));
    }
  });
}

async function stateOf(userId: string, entryId: string) {
  const [row] = await db
    .select({
      read: userEntries.read,
      starred: userEntries.starred,
      readChangedAt: userEntries.readChangedAt,
      starredChangedAt: userEntries.starredChangedAt,
      updatedAt: userEntries.updatedAt,
      sortDay: sql<string>`to_char(${userEntries.publishedOrFetchedAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
    })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
  return row ?? null;
}

async function expectCountersMatchRecount(userId: string, subscriptionId: string) {
  const [sub] = await db
    .select({ unread: subscriptions.unreadCount, starredUnread: subscriptions.starredUnreadCount })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  const [subActual] = await db
    .select({
      unread: sql<number>`count(*) filter (where not read)::int`,
      starredUnread: sql<number>`count(*) filter (where starred and not read)::int`,
    })
    .from(userEntries)
    .where(eq(userEntries.subscriptionId, subscriptionId));
  expect(sub).toEqual(subActual);

  const [user] = await db
    .select({ starredUnread: users.starredUnreadCount })
    .from(users)
    .where(eq(users.id, userId));
  const [userActual] = await db
    .select({ starredUnread: sql<number>`count(*) filter (where starred and not read)::int` })
    .from(userEntries)
    .where(eq(userEntries.userId, userId));
  expect(user).toEqual(userActual);
}

describe("migration 0109: merge scheme-twin entries", () => {
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  it("ends the migration with the index and keeps the merge free of DDL on it", () => {
    expect(createIndexStatement).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS ${INDEX_NAME}`);
    expect(mergeStatements.some((s) => s.includes("CREATE"))).toBe(true);
    expect(mergeStatements.some((s) => s.includes("INDEX"))).toBe(false);
  });

  it("merges twins into the oldest row, keeping newest content and any unread/starred state", async () => {
    const feedId = await createTestFeed();
    const otherFeedId = await createTestFeed();

    const t1 = new Date("2026-08-01T00:00:00Z");
    const t2 = new Date("2026-08-02T00:00:00Z");
    const t3 = new Date("2026-08-03T00:00:00Z");
    const t4 = new Date("2026-08-04T00:00:00Z");
    const survivorPublishedAt = new Date("2026-07-01T00:00:00Z");

    await db.execute(sql.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`));
    try {
      const survivor = await createTestEntry(feedId, {
        guid: "http://example.com/?p=1",
        contentOriginal: "v1",
        contentHash: "hash-v1",
        publishedAt: survivorPublishedAt,
        updatedAt: t1,
        lastSeenAt: t1,
      });
      // UUIDv7 ids only order across milliseconds.
      await new Promise((resolve) => setTimeout(resolve, 5));
      const loser = await createTestEntry(feedId, {
        guid: "https://example.com/?p=1",
        contentOriginal: "v2 (edited)",
        contentHash: "hash-v2",
        publishedAt: null,
        fetchedAt: t2,
        updatedAt: t2,
        lastSeenAt: t3,
        fullContentOriginal: "full text",
        fullContentHash: "full-hash",
        fullContentFetchedAt: t2,
      });
      // A second group on the same feed.
      const survivor2 = await createTestEntry(feedId, { guid: "http://example.com/?p=3" });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const loser2 = await createTestEntry(feedId, { guid: "https://example.com/?p=3" });
      // Same canonical guid on another feed: not a twin.
      const otherFeedEntry = await createTestEntry(otherFeedId, {
        guid: "https://example.com/?p=1",
      });
      // Different guid on the same feed: not a twin.
      const unrelated = await createTestEntry(feedId, { guid: "https://example.com/?p=2" });
      // Saved-article twins are outside the rule and must be left alone.
      const savedUser = await createTestUser({ emailPrefix: "saved" });
      const savedFeedId = await createTestFeed({ type: "saved", url: null, userId: savedUser });
      const savedA = await createTestEntry(savedFeedId, {
        type: "saved",
        guid: "http://example.com/a",
      });
      const savedB = await createTestEntry(savedFeedId, {
        type: "saved",
        guid: "https://example.com/a",
      });

      // both rows: survivor read, loser unread+starred → unread+starred
      const userBoth = await createTestUser({ emailPrefix: "both" });
      const subBoth = await createTestSubscription(userBoth, feedId);
      // loser only: read+starred → re-pointed as-is, sort key recomputed
      const userLoserOnly = await createTestUser({ emailPrefix: "loser" });
      const subLoserOnly = await createTestSubscription(userLoserOnly, feedId);
      // survivor only: untouched
      const userSurvivorOnly = await createTestUser({ emailPrefix: "survivor" });
      const subSurvivorOnly = await createTestSubscription(userSurvivorOnly, feedId);
      // both read: stays read, updated_at untouched, read_changed_at advances
      const userBothRead = await createTestUser({ emailPrefix: "bothread" });
      const subBothRead = await createTestSubscription(userBothRead, feedId);
      // survivor unread, loser read later: stays unread, read_changed_at advances
      const userUnreadSurvivor = await createTestUser({ emailPrefix: "unreadsurvivor" });
      const subUnreadSurvivor = await createTestSubscription(userUnreadSurvivor, feedId);

      const stale = new Date("2026-08-01T00:00:00Z");
      await db.insert(userEntries).values([
        {
          userId: userBoth,
          entryId: survivor,
          read: true,
          starred: false,
          readChangedAt: t1,
          starredChangedAt: t1,
        },
        { userId: userBoth, entryId: loser, read: false, starred: true, starredChangedAt: t2 },
        { userId: userBoth, entryId: unrelated, read: false, starred: false },
        { userId: userBoth, entryId: survivor2, read: false, starred: false },
        { userId: userBoth, entryId: loser2, read: false, starred: false },
        { userId: userLoserOnly, entryId: loser, read: true, starred: true },
        { userId: userSurvivorOnly, entryId: survivor, read: false, starred: false },
        {
          userId: userBothRead,
          entryId: survivor,
          read: true,
          starred: false,
          readChangedAt: t1,
          updatedAt: stale,
        },
        {
          userId: userBothRead,
          entryId: loser,
          read: true,
          starred: false,
          readChangedAt: t4,
          updatedAt: stale,
        },
        {
          userId: userUnreadSurvivor,
          entryId: survivor,
          read: false,
          starred: false,
          readChangedAt: t1,
          starredChangedAt: t1,
        },
        {
          userId: userUnreadSurvivor,
          entryId: loser,
          read: true,
          starred: false,
          readChangedAt: t4,
          starredChangedAt: t4,
        },
      ]);

      await runMerge();

      const remaining = await db.select().from(entries).where(eq(entries.feedId, feedId));
      expect(remaining.map((e) => e.id).sort()).toEqual([survivor, survivor2, unrelated].sort());
      const merged = remaining.find((e) => e.id === survivor)!;
      expect(merged.guid).toBe("http://example.com/?p=1");
      expect(merged.contentOriginal).toBe("v2 (edited)");
      expect(merged.contentHash).toBe("hash-v2");
      expect(merged.updatedAt).toEqual(t2);
      expect(merged.lastSeenAt).toEqual(t3);
      expect(merged.publishedAt).toEqual(survivorPublishedAt);
      expect(merged.fullContentOriginal).toBe("full text");
      expect(merged.fullContentHash).toBe("full-hash");
      expect(await db.select().from(entries).where(eq(entries.id, otherFeedEntry))).toHaveLength(1);
      const savedRows = await db
        .select({ id: entries.id })
        .from(entries)
        .where(eq(entries.feedId, savedFeedId));
      expect(savedRows.map((r) => r.id).sort()).toEqual([savedA, savedB].sort());

      expect(await stateOf(userBoth, loser)).toBeNull();
      expect(await stateOf(userBoth, loser2)).toBeNull();
      const both = (await stateOf(userBoth, survivor))!;
      expect(both.read).toBe(false);
      expect(both.starred).toBe(true);
      expect(both.starredChangedAt).toEqual(t2);
      expect(both.readChangedAt).toEqual(t1);
      expect(both.sortDay).toBe("2026-07-01");

      const loserOnly = (await stateOf(userLoserOnly, survivor))!;
      expect(loserOnly.read).toBe(true);
      expect(loserOnly.starred).toBe(true);
      expect(loserOnly.sortDay).toBe("2026-07-01");
      expect(loserOnly.updatedAt.getTime()).toBeGreaterThan(t4.getTime());
      expect(await stateOf(userLoserOnly, loser)).toBeNull();

      const survivorOnly = (await stateOf(userSurvivorOnly, survivor))!;
      expect(survivorOnly.read).toBe(false);
      expect(survivorOnly.starred).toBe(false);

      const bothRead = (await stateOf(userBothRead, survivor))!;
      expect(bothRead.read).toBe(true);
      expect(bothRead.readChangedAt).toEqual(t4);
      expect(bothRead.updatedAt).toEqual(stale);

      const unreadSurvivor = (await stateOf(userUnreadSurvivor, survivor))!;
      expect(unreadSurvivor.read).toBe(false);
      expect(unreadSurvivor.readChangedAt).toEqual(t4);
      expect(unreadSurvivor.starredChangedAt).toEqual(t4);

      for (const [userId, subscriptionId] of [
        [userBoth, subBoth],
        [userLoserOnly, subLoserOnly],
        [userSurvivorOnly, subSurvivorOnly],
        [userBothRead, subBothRead],
        [userUnreadSurvivor, subUnreadSurvivor],
      ]) {
        await expectCountersMatchRecount(userId, subscriptionId);
      }
      const [subBothRow] = await db
        .select({
          unread: subscriptions.unreadCount,
          starredUnread: subscriptions.starredUnreadCount,
        })
        .from(subscriptions)
        .where(eq(subscriptions.id, subBoth));
      expect(subBothRow).toEqual({ unread: 3, starredUnread: 1 });
    } finally {
      await db.execute(sql.raw(createIndexStatement));
    }
  });

  it("is a no-op when there are no twins and leaves the index in place", async () => {
    const feedId = await createTestFeed();
    const a = await createTestEntry(feedId, { guid: "https://example.com/?p=1" });
    const b = await createTestEntry(feedId, { guid: "https://example.com/?p=2" });
    await runMerge();
    const rows = await db
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.feedId, feedId));
    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
    const [index] = await db
      .execute<{ indexname: string }>(
        sql`SELECT indexname FROM pg_indexes WHERE indexname = ${INDEX_NAME}`
      )
      .then((r) => r.rows);
    expect(index?.indexname).toBe(INDEX_NAME);
  });

  it("rejects a web twin at the database but not a saved-article one", async () => {
    const feedId = await createTestFeed();
    await createTestEntry(feedId, { guid: "http://example.com/?p=1" });
    await expect(
      createTestEntry(feedId, { guid: "https://example.com/?p=1" })
    ).rejects.toMatchObject({ cause: { constraint: INDEX_NAME } });

    const userId = await createTestUser({ emailPrefix: "saved" });
    const savedFeedId = await createTestFeed({ type: "saved", url: null, userId });
    await createTestEntry(savedFeedId, { type: "saved", guid: "http://example.com/a" });
    await createTestEntry(savedFeedId, { type: "saved", guid: "https://example.com/a" });
  });
});
