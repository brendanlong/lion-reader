/**
 * Integration tests for the Getting Started onboarding article (issue #1397).
 *
 * The behavior worth pinning down is the once-ever guarantee: the article shows
 * up starred and unread for a new user, and once a user has had it, nothing —
 * a second signup-path call, the backfill job, or deleting the article — brings
 * it back (issue #1383).
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
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

const DRAIN_BATCH = 200;
const DRAIN_MAX_ROUNDS = 25;

/**
 * Runs the backfill until no pending users are left.
 *
 * The backfill is global by design, and this database is shared with the other
 * integration test files, so a single batch isn't guaranteed to reach our user.
 * Draining is also what makes the "no pending users left" assertion meaningful.
 */
async function drainBackfill(): Promise<{ rounds: number; created: number }> {
  let created = 0;
  for (let rounds = 1; rounds <= DRAIN_MAX_ROUNDS; rounds++) {
    const result = await backfillGettingStartedArticles(db, DRAIN_BATCH);
    created += result.created;
    if (result.attempted === 0) return { rounds, created };
  }
  return { rounds: DRAIN_MAX_ROUNDS, created };
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
    await drainBackfill();

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

    const { rounds, created } = await drainBackfill();

    expect(created).toBeGreaterThan(0);
    // Every round but the last filled a full batch, so this converged.
    expect(rounds).toBeLessThan(DRAIN_MAX_ROUNDS);
    expect(await gettingStartedAt(userId)).toBeInstanceOf(Date);
    expect(await savedEntriesFor(userId)).toHaveLength(1);

    // Nothing is left over: a second pass finds no pending users.
    expect(await backfillGettingStartedArticles(db, DRAIN_BATCH)).toEqual({
      attempted: 0,
      created: 0,
      failed: 0,
    });
  });
});
