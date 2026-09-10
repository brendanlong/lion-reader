/**
 * Integration tests for migration 0109 (issue #1535): merging web entries whose
 * guids differ only by http/https scheme, and the unique index that then
 * forbids new twins.
 *
 * Migrations already ran against the test database, so the merge is exercised
 * by replaying the migration file's statements over seeded twins with the
 * unique index temporarily dropped, then recreating the index from the same
 * file. The file layout the test relies on: every statement before the
 * CREATE UNIQUE INDEX is part of the merge.
 */

import { readFileSync } from "fs";
import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds, subscriptions, userEntries, users } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createTestFeed, createTestSubscription, createTestUser } from "./helpers";

const INDEX_NAME = "uq_entries_feed_guid_canonical";

const migrationStatements = readFileSync(
  new URL("../../migrations/0109_merge_scheme_twin_entries.sql", import.meta.url),
  "utf8"
)
  .split("--> statement-breakpoint")
  .map((statement) => statement.trim())
  .filter((statement) => statement.length > 0);

const mergeStatements = migrationStatements.filter((s) => !s.includes("CREATE UNIQUE INDEX"));
const createIndexStatement = migrationStatements.find((s) => s.includes("CREATE UNIQUE INDEX"));

async function runMerge() {
  await db.transaction(async (tx) => {
    for (const statement of mergeStatements) {
      await tx.execute(sql.raw(statement));
    }
  });
}

async function insertWebEntry(
  feedId: string,
  guid: string,
  overrides: Partial<typeof entries.$inferInsert> = {}
) {
  const id = overrides.id ?? generateUuidv7();
  const now = new Date();
  await db.insert(entries).values({
    id,
    feedId,
    type: "web",
    guid,
    url: "https://example.com/post/",
    title: "Post",
    contentOriginal: "v1",
    contentHash: "hash-v1",
    publishedAt: now,
    fetchedAt: now,
    lastSeenAt: now,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  });
  return id;
}

async function unreadCount(subscriptionId: string) {
  const [row] = await db
    .select({ unread: subscriptions.unreadCount, starredUnread: subscriptions.starredUnreadCount })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  const [actual] = await db
    .select({
      unread: sql<number>`count(*) filter (where not read)::int`,
      starredUnread: sql<number>`count(*) filter (where starred and not read)::int`,
    })
    .from(userEntries)
    .where(eq(userEntries.subscriptionId, subscriptionId));
  return { counter: row, actual };
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

  it("splits the migration into merge statements plus the index", () => {
    expect(mergeStatements.length).toBeGreaterThan(3);
    expect(createIndexStatement).toContain(INDEX_NAME);
  });

  it("merges twins into the oldest row, keeping newest content and any unread/starred state", async () => {
    const feedId = await createTestFeed();
    const otherFeedId = await createTestFeed();

    const t1 = new Date("2026-08-01T00:00:00Z");
    const t2 = new Date("2026-08-02T00:00:00Z");
    const t3 = new Date("2026-08-03T00:00:00Z");

    await db.execute(sql.raw(`DROP INDEX IF EXISTS ${INDEX_NAME}`));
    try {
      const survivor = await insertWebEntry(feedId, "http://example.com/?p=1", {
        contentOriginal: "v1",
        contentHash: "hash-v1",
        updatedAt: t1,
        lastSeenAt: t1,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      const loser = await insertWebEntry(feedId, "https://example.com/?p=1", {
        contentOriginal: "v2 (edited)",
        contentHash: "hash-v2",
        updatedAt: t2,
        lastSeenAt: t3,
      });
      // Same canonical guid on another feed: not a twin.
      const otherFeedEntry = await insertWebEntry(otherFeedId, "https://example.com/?p=1");
      // Different guid on the same feed: not a twin.
      const unrelated = await insertWebEntry(feedId, "https://example.com/?p=2");

      // both: survivor read+unstarred, loser unread+starred → unread+starred
      const userBoth = await createTestUser({ emailPrefix: "both" });
      const subBoth = await createTestSubscription(userBoth, feedId);
      // loser only: read+starred → re-pointed as-is
      const userLoserOnly = await createTestUser({ emailPrefix: "loser" });
      const subLoserOnly = await createTestSubscription(userLoserOnly, feedId);
      // survivor only: untouched
      const userSurvivorOnly = await createTestUser({ emailPrefix: "survivor" });
      const subSurvivorOnly = await createTestSubscription(userSurvivorOnly, feedId);
      // both read: stays read, updated_at untouched
      const userBothRead = await createTestUser({ emailPrefix: "bothread" });
      const subBothRead = await createTestSubscription(userBothRead, feedId);

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
        { userId: userLoserOnly, entryId: loser, read: true, starred: true },
        { userId: userSurvivorOnly, entryId: survivor, read: false, starred: false },
        { userId: userBothRead, entryId: survivor, read: true, starred: false, updatedAt: stale },
        { userId: userBothRead, entryId: loser, read: true, starred: false, updatedAt: stale },
      ]);

      await runMerge();

      const remaining = await db.select().from(entries).where(eq(entries.feedId, feedId));
      expect(remaining.map((e) => e.id).sort()).toEqual([survivor, unrelated].sort());
      const merged = remaining.find((e) => e.id === survivor)!;
      expect(merged.guid).toBe("http://example.com/?p=1");
      expect(merged.contentOriginal).toBe("v2 (edited)");
      expect(merged.contentHash).toBe("hash-v2");
      expect(merged.updatedAt).toEqual(t2);
      expect(merged.lastSeenAt).toEqual(t3);
      expect(await db.select().from(entries).where(eq(entries.id, otherFeedEntry))).toHaveLength(1);

      const stateOf = async (userId: string, entryId: string) => {
        const [row] = await db
          .select()
          .from(userEntries)
          .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
        return row ?? null;
      };
      expect(await stateOf(userBoth, loser)).toBeNull();
      const both = (await stateOf(userBoth, survivor))!;
      expect(both.read).toBe(false);
      expect(both.starred).toBe(true);
      expect(both.starredChangedAt).toEqual(t2);
      expect(both.readChangedAt).toEqual(t1);

      const loserOnly = (await stateOf(userLoserOnly, survivor))!;
      expect(loserOnly.read).toBe(true);
      expect(loserOnly.starred).toBe(true);
      expect(await stateOf(userLoserOnly, loser)).toBeNull();

      const survivorOnly = (await stateOf(userSurvivorOnly, survivor))!;
      expect(survivorOnly.read).toBe(false);
      expect(survivorOnly.starred).toBe(false);

      const bothRead = (await stateOf(userBothRead, survivor))!;
      expect(bothRead.read).toBe(true);
      expect(bothRead.updatedAt).toEqual(stale);

      for (const subscriptionId of [subBoth, subLoserOnly, subSurvivorOnly, subBothRead]) {
        const { counter, actual } = await unreadCount(subscriptionId);
        expect(counter).toEqual(actual);
      }
      expect((await unreadCount(subBoth)).actual).toEqual({ unread: 2, starredUnread: 1 });
    } finally {
      await db.execute(sql.raw(createIndexStatement!));
    }
  });

  it("is a no-op when there are no twins and leaves the index in place", async () => {
    const feedId = await createTestFeed();
    const a = await insertWebEntry(feedId, "https://example.com/?p=1");
    const b = await insertWebEntry(feedId, "https://example.com/?p=2");
    await runMerge();
    const rows = await db
      .select({ id: entries.id })
      .from(entries)
      .where(eq(entries.feedId, feedId));
    expect(rows.map((r) => r.id).sort()).toEqual([a, b].sort());
  });

  it("rejects a web twin at the database but not a saved-article one", async () => {
    const feedId = await createTestFeed();
    await insertWebEntry(feedId, "http://example.com/?p=1");
    await expect(insertWebEntry(feedId, "https://example.com/?p=1")).rejects.toMatchObject({
      cause: { constraint: INDEX_NAME },
    });

    const userId = await createTestUser({ emailPrefix: "saved" });
    const savedFeedId = await createTestFeed({ type: "saved", url: null, userId });
    const now = new Date();
    for (const guid of ["http://example.com/a", "https://example.com/a"]) {
      await db.insert(entries).values({
        id: generateUuidv7(),
        feedId: savedFeedId,
        type: "saved",
        guid,
        title: "Saved",
        contentHash: "h",
        fetchedAt: now,
        createdAt: now,
        updatedAt: now,
      });
    }
  });
});
