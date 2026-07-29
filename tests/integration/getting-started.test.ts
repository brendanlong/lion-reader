/**
 * Integration tests for the Getting Started onboarding article (issue #1397).
 *
 * The behavior worth pinning down is the once-ever guarantee: the article shows
 * up starred and unread for a new user, and once a user has had it, nothing —
 * a second signup-path call, the backfill job, or deleting the article — brings
 * it back (issue #1383).
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, entries, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import {
  backfillGettingStartedArticles,
  createGettingStartedArticle,
} from "../../src/server/services/getting-started";
import { GETTING_STARTED_TITLE } from "../../src/server/services/getting-started-content";
import { deleteSavedArticle } from "../../src/server/services/saved";
import { getSavedFeedId } from "../../src/server/feed/saved-feed";

const createdUserIds: string[] = [];

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `getting-started-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
}

/** Every saved entry the user can see, newest first. */
async function savedEntriesFor(userId: string) {
  const savedFeedId = await getSavedFeedId(db, userId);
  if (!savedFeedId) return [];
  return db
    .select({
      id: entries.id,
      title: entries.title,
      summary: entries.summary,
      contentOriginal: entries.contentOriginal,
      read: userEntries.read,
      starred: userEntries.starred,
    })
    .from(entries)
    .innerJoin(
      userEntries,
      and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, userId))
    )
    .where(eq(entries.feedId, savedFeedId));
}

async function gettingStartedAt(userId: string): Promise<Date | null> {
  const [row] = await db
    .select({ at: users.gettingStartedAt })
    .from(users)
    .where(eq(users.id, userId));
  return row.at;
}

const BATCH = 100;

/**
 * Marks every *other* user in this database as already covered.
 *
 * The backfill is global by design, and this database is shared with 50-odd
 * other integration files whose leftover user rows are all pending. Without
 * this the backfill would create articles for them (slow, and it mutates rows
 * this file doesn't own) and the batch counts would depend on how dirty the
 * database happened to be. Stamping the flag — and only the flag — leaves our
 * user as the single pending row, so the counts below are exact.
 */
async function claimEveryoneElse(ourUserId: string): Promise<void> {
  await db
    .update(users)
    .set({ gettingStartedAt: new Date() })
    .where(and(isNull(users.gettingStartedAt), ne(users.id, ourUserId)));
}

afterAll(async () => {
  for (const id of createdUserIds) {
    await db.delete(users).where(eq(users.id, id));
  }
});

describe("createGettingStartedArticle", () => {
  it("adds a starred, unread saved article and stamps the user", async () => {
    const userId = await createTestUser();

    const entryId = await createGettingStartedArticle(db, userId);
    expect(entryId).not.toBeNull();

    const saved = await savedEntriesFor(userId);
    expect(saved).toHaveLength(1);
    expect(saved[0].title).toBe(GETTING_STARTED_TITLE);
    expect(saved[0].starred).toBe(true);
    expect(saved[0].read).toBe(false);
    // Rendered through the Markdown pipeline, with its in-app links intact.
    expect(saved[0].contentOriginal).toContain('href="/subscribe"');
    expect(saved[0].summary).toBeTruthy();

    expect(await gettingStartedAt(userId)).toBeInstanceOf(Date);

    // The starred counter the badge reads must see it.
    const [counts] = await db
      .select({ starred: users.starredUnreadCount, saved: users.savedUnreadCount })
      .from(users)
      .where(eq(users.id, userId));
    expect(counts.starred).toBe(1);
    expect(counts.saved).toBe(1);
  });

  it("is a no-op the second time", async () => {
    const userId = await createTestUser();

    expect(await createGettingStartedArticle(db, userId)).not.toBeNull();
    expect(await createGettingStartedArticle(db, userId)).toBeNull();

    expect(await savedEntriesFor(userId)).toHaveLength(1);
  });

  it("does not re-add the article after the user deletes it", async () => {
    const userId = await createTestUser();

    const entryId = await createGettingStartedArticle(db, userId);
    expect(entryId).not.toBeNull();
    expect(await deleteSavedArticle(db, userId, entryId!)).toBe(true);

    // Both the signup path and the backfill must leave it deleted.
    expect(await createGettingStartedArticle(db, userId)).toBeNull();
    await claimEveryoneElse(userId);
    expect(await backfillGettingStartedArticles(db, BATCH)).toEqual({
      attempted: 0,
      created: 0,
      failed: 0,
    });

    expect(await savedEntriesFor(userId)).toHaveLength(0);
  });

  it("leaves an unstarred copy unstarred", async () => {
    const userId = await createTestUser();
    const entryId = await createGettingStartedArticle(db, userId);

    await db
      .update(userEntries)
      .set({ starred: false })
      .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId!)));

    expect(await createGettingStartedArticle(db, userId)).toBeNull();

    const saved = await savedEntriesFor(userId);
    expect(saved).toHaveLength(1);
    expect(saved[0].starred).toBe(false);
  });
});

describe("backfillGettingStartedArticles", () => {
  it("covers a user who predates the feature", async () => {
    const userId = await createTestUser();
    expect(await gettingStartedAt(userId)).toBeNull();
    await claimEveryoneElse(userId);

    expect(await backfillGettingStartedArticles(db, BATCH)).toEqual({
      attempted: 1,
      created: 1,
      failed: 0,
    });

    expect(await gettingStartedAt(userId)).toBeInstanceOf(Date);
    expect(await savedEntriesFor(userId)).toHaveLength(1);

    // Nothing is left over: a second pass finds no pending users.
    expect(await backfillGettingStartedArticles(db, BATCH)).toEqual({
      attempted: 0,
      created: 0,
      failed: 0,
    });
  });
});
