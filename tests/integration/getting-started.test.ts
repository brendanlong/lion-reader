/**
 * Integration tests for the Getting Started onboarding collection (issue #1397).
 *
 * The behavior worth pinning down: a new user gets one collection of unread
 * articles that opens in reading order, and once a user has had it, nothing —
 * a second signup-path call, the backfill job, or deleting it — brings it back
 * (issue #1383).
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq, isNull, ne } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, entries } from "../../src/server/db/schema";
import {
  backfillGettingStartedCollections,
  createGettingStartedCollection,
} from "../../src/server/services/getting-started";
import {
  GETTING_STARTED_ARTICLES,
  GETTING_STARTED_COLLECTION_NAME,
} from "../../src/server/services/getting-started-content";
import { listEntries } from "../../src/server/services/entries";
import { deleteCollection } from "../../src/server/services/collections";
import { listSubscriptions } from "../../src/server/services/subscriptions";
import { createTestUser } from "./helpers";

const createdUserIds: string[] = [];

/** Creates a user and registers it for `afterAll` cleanup. */
async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "getting-started" });
  createdUserIds.push(userId);
  return userId;
}

async function savedEntryCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: entries.id })
    .from(entries)
    .where(eq(entries.ownerUserId, userId));
  return rows.length;
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
 * this the backfill would create collections for them (slow, and it mutates
 * rows this file doesn't own) and the batch counts would depend on how dirty
 * the database happened to be. Stamping the flag — and only the flag — leaves
 * our user as the single pending row, so the counts below are exact.
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

describe("createGettingStartedCollection", () => {
  it("adds a collection of unread articles that opens in reading order", async () => {
    const userId = await createUser();

    const collectionId = await createGettingStartedCollection(db, userId);
    expect(collectionId).not.toBeNull();
    expect(await gettingStartedAt(userId)).toBeInstanceOf(Date);

    const { subscriptions: collections } = await listSubscriptions(db, {
      userId,
      type: "collection",
    });
    expect(collections.map((sub) => [sub.id, sub.title])).toEqual([
      [collectionId, GETTING_STARTED_COLLECTION_NAME],
    ]);

    // No sort named: the collection's default, which its positions make reading order.
    const { items } = await listEntries(db, {
      userId,
      subscriptionId: collectionId!,
      showSpam: false,
    });
    expect(items.map((item) => item.title)).toEqual(
      GETTING_STARTED_ARTICLES.map((article) => article.title)
    );
    expect(items.every((item) => !item.read && !item.starred)).toBe(true);
    expect(items.every((item) => item.siteName === "Lion Reader")).toBe(true);

    // Newest-first lists show them in reading order too.
    const { items: saved } = await listEntries(db, { userId, type: "saved", showSpam: false });
    expect(saved.map((item) => item.title)).toEqual(
      GETTING_STARTED_ARTICLES.map((article) => article.title)
    );

    // Rendered through the Markdown pipeline, with in-app links left relative
    // (same-tab) rather than resolved against the upload host.
    const [first] = await db
      .select({ contentCleaned: entries.contentCleaned })
      .from(entries)
      .where(eq(entries.id, items[0].id));
    expect(first.contentCleaned).toContain('href="/subscribe"');
  });

  it("does not re-add the collection after the user deletes it", async () => {
    const userId = await createUser();

    const collectionId = await createGettingStartedCollection(db, userId);
    await deleteCollection(db, userId, collectionId!, { deleteSavedArticles: true });
    expect(await savedEntryCount(userId)).toBe(0);

    // Both the signup path and the backfill must leave it deleted.
    expect(await createGettingStartedCollection(db, userId)).toBeNull();
    await claimEveryoneElse(userId);
    expect(await backfillGettingStartedCollections(db, BATCH)).toEqual({
      attempted: 0,
      created: 0,
      failed: 0,
    });

    expect(await savedEntryCount(userId)).toBe(0);
  });

  it("finishes without duplicates when the claim is released after the inserts committed", async () => {
    const userId = await createUser();
    const collectionId = await createGettingStartedCollection(db, userId);
    // What a failure after the inserts leaves: the collection, but no claim.
    await db.update(users).set({ gettingStartedAt: null }).where(eq(users.id, userId));

    expect(await createGettingStartedCollection(db, userId)).toBe(collectionId);
    expect(await savedEntryCount(userId)).toBe(GETTING_STARTED_ARTICLES.length);
  });
  it("files the articles an earlier attempt uploaded into a new collection on retry", async () => {
    const userId = await createUser();
    const firstId = await createGettingStartedCollection(db, userId);
    // What a retry can find: the articles uploaded, the collection gone.
    await deleteCollection(db, userId, firstId!);
    await db.update(users).set({ gettingStartedAt: null }).where(eq(users.id, userId));

    const secondId = await createGettingStartedCollection(db, userId);
    expect(secondId).not.toBe(firstId);
    const { items } = await listEntries(db, { userId, subscriptionId: secondId!, showSpam: false });
    expect(items.map((item) => item.title)).toEqual(
      GETTING_STARTED_ARTICLES.map((article) => article.title)
    );
    expect(await savedEntryCount(userId)).toBe(GETTING_STARTED_ARTICLES.length);
  });
});

describe("backfillGettingStartedCollections", () => {
  it("covers a user whose signup-path insert never happened", async () => {
    const userId = await createUser();
    expect(await gettingStartedAt(userId)).toBeNull();
    await claimEveryoneElse(userId);

    expect(await backfillGettingStartedCollections(db, BATCH)).toEqual({
      attempted: 1,
      created: 1,
      failed: 0,
    });

    expect(await gettingStartedAt(userId)).toBeInstanceOf(Date);
    expect(await savedEntryCount(userId)).toBe(GETTING_STARTED_ARTICLES.length);

    // Nothing is left over: a second pass finds no pending users.
    expect(await backfillGettingStartedCollections(db, BATCH)).toEqual({
      attempted: 0,
      created: 0,
      failed: 0,
    });
  });
});
