/**
 * Integration tests for collections (#1806): membership counters, visibility,
 * entry filters, deletion, and cross-user isolation.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { and, eq, inArray, sql, TransactionRollbackError } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  collectionEntries,
  entries,
  feeds,
  subscriptionTags,
  subscriptions,
  tags,
  userEntries,
  users,
} from "../../src/server/db/schema";
import {
  addEntriesToCollection,
  createCollection,
  removeEntriesFromCollection,
} from "../../src/server/services/collections";
import {
  getEntries,
  listEntries,
  markAllEntriesRead,
  markEntriesRead,
  updateEntryStarred,
} from "../../src/server/services/entries";
import { getBulkEntryRelatedCounts, getGlobalUnreadCounts } from "../../src/server/services/counts";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";
import { deleteSavedArticle, uploadArticle } from "../../src/server/services/saved";
import { createCaller } from "../../src/server/trpc/root";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

async function cleanup(): Promise<void> {
  await db.delete(collectionEntries);
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionTags);
  await db.delete(tags);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

async function counters(subscriptionId: string) {
  const [row] = await db
    .select({ unread: subscriptions.unreadCount, starredUnread: subscriptions.starredUnreadCount })
    .from(subscriptions)
    .where(eq(subscriptions.id, subscriptionId));
  return row;
}

async function savedEntryCount(userId: string): Promise<number> {
  const rows = await db
    .select({ id: entries.id })
    .from(entries)
    .innerJoin(userEntries, eq(userEntries.entryId, entries.id))
    .where(and(eq(userEntries.userId, userId), eq(entries.type, "saved")));
  return rows.length;
}

async function tagUnread(tagId: string): Promise<number> {
  const [row] = await db.select({ unread: tags.unreadCount }).from(tags).where(eq(tags.id, tagId));
  return row.unread;
}

async function expectNoDrift(): Promise<void> {
  expect(await reconcileCounters(db)).toEqual({
    subscriptionsFixed: 0,
    usersFixed: 0,
    tagsFixed: 0,
  });
}

async function listIds(userId: string, filter: { subscriptionId?: string; tagId?: string }) {
  const { items } = await listEntries(db, { userId, ...filter, showSpam: false });
  return items.map((item) => item.id).sort();
}

/** A user subscribed to one feed with two unread entries, and an empty collection. */
async function setup() {
  const userId = await createTestUser();
  const feedId = await createTestFeed();
  const sourceId = await createTestSubscription(userId, feedId);
  const entryA = await createTestEntry(feedId, { userIds: [userId] });
  const entryB = await createTestEntry(feedId, { userIds: [userId] });
  const { subscription } = await createCollection(db, userId, "Research");
  return { userId, feedId, sourceId, entryA, entryB, collectionId: subscription.id };
}

describe("collections", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  describe("counters", () => {
    it("tracks unread and starred members through add, read, star and remove", async () => {
      const { userId, entryA, entryB, collectionId } = await setup();

      await addEntriesToCollection(db, userId, collectionId, [entryA, entryB]);
      expect(await counters(collectionId)).toEqual({ unread: 2, starredUnread: 0 });

      await markEntriesRead(db, userId, [{ id: entryA }], true);
      await updateEntryStarred(db, userId, entryB, true);
      expect(await counters(collectionId)).toEqual({ unread: 1, starredUnread: 1 });

      await removeEntriesFromCollection(db, userId, collectionId, [entryB]);
      expect(await counters(collectionId)).toEqual({ unread: 0, starredUnread: 0 });
      await expectNoDrift();
    });

    it("drops a member's contribution exactly once when its entry is deleted", async () => {
      // The user_entries delete trigger takes the member's contribution off
      // before removing the membership, so nothing is counted out twice.
      const { userId, collectionId } = await setup();
      const saved = await uploadArticle(db, userId, { content: "Body", title: "Paper" });
      await addEntriesToCollection(db, userId, collectionId, [saved.id]);
      expect(await counters(collectionId)).toEqual({ unread: 1, starredUnread: 0 });

      await deleteSavedArticle(db, userId, saved.id);

      expect(await counters(collectionId)).toEqual({ unread: 0, starredUnread: 0 });
      await expectNoDrift();
    });

    it("counts an article in both its feed and a collection once toward All", async () => {
      const { userId, entryA, collectionId } = await setup();

      await addEntriesToCollection(db, userId, collectionId, [entryA]);

      expect((await getGlobalUnreadCounts(db, userId)).allUnread).toBe(2);
    });

    it("moves a tag holding the article's feed and collection by one per read", async () => {
      const { userId, sourceId, entryA, collectionId } = await setup();
      const tagId = await createTestTag(userId, { subscriptionIds: [sourceId, collectionId] });
      await addEntriesToCollection(db, userId, collectionId, [entryA]);
      expect(await tagUnread(tagId)).toBe(2);

      const { counts } = await markEntriesRead(db, userId, [{ id: entryA }], true);

      expect(await tagUnread(tagId)).toBe(1);
      expect(counts?.tags).toEqual([{ id: tagId, unread: 1 }]);
      await expectNoDrift();
    });

    it("counts an untagged collection's members once in Uncategorized", async () => {
      // New collections start untagged, alongside untagged feeds.
      const { userId, entryA, collectionId } = await setup();

      await addEntriesToCollection(db, userId, collectionId, [entryA]);

      const [user] = await db
        .select({ uncategorized: users.uncategorizedUnreadCount })
        .from(users)
        .where(eq(users.id, userId));
      expect(user.uncategorized).toBe(2);
    });

    it("keeps the counters exact when a user with members is deleted", async () => {
      const { userId, entryA, collectionId } = await setup();
      const other = await setup();
      await addEntriesToCollection(db, userId, collectionId, [entryA]);

      await db.delete(users).where(eq(users.id, userId));

      expect((await getGlobalUnreadCounts(db, other.userId)).allUnread).toBe(2);
      await expectNoDrift();
    });

    it("returns the collections holding a marked entry among the affected counts", async () => {
      const { userId, sourceId, entryA, collectionId } = await setup();
      await addEntriesToCollection(db, userId, collectionId, [entryA]);

      const { counts } = await markEntriesRead(db, userId, [{ id: entryA }], true);

      expect(counts?.subscriptions).toEqual(
        expect.arrayContaining([
          { id: sourceId, unread: 1, tagIds: [] },
          { id: collectionId, unread: 0, tagIds: [] },
        ])
      );
    });
  });

  describe("visibility", () => {
    it("keeps members visible after unsubscribing from their source, until removed", async () => {
      const { userId, sourceId, entryA, entryB, collectionId } = await setup();
      await addEntriesToCollection(db, userId, collectionId, [entryA]);

      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, sourceId));

      expect((await getEntries(db, userId, [entryA, entryB])).map((e) => e.id)).toEqual([entryA]);
      expect(await listIds(userId, { subscriptionId: collectionId })).toEqual([entryA]);
      expect((await getGlobalUnreadCounts(db, userId)).allUnread).toBe(1);

      await removeEntriesFromCollection(db, userId, collectionId, [entryA]);

      expect(await getEntries(db, userId, [entryA])).toEqual([]);
      expect((await getGlobalUnreadCounts(db, userId)).allUnread).toBe(0);
    });

    it("deleting a collection empties it and hides members of unsubscribed sources", async () => {
      const { userId, sourceId, entryA, collectionId } = await setup();
      await addEntriesToCollection(db, userId, collectionId, [entryA]);
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, sourceId));
      const caller = createCaller(await createAuthContext(userId));

      await caller.subscriptions.delete({ id: collectionId });

      expect(
        await db
          .select()
          .from(collectionEntries)
          .where(eq(collectionEntries.subscriptionId, collectionId))
      ).toEqual([]);
      expect(await getEntries(db, userId, [entryA])).toEqual([]);
      expect(await counters(collectionId)).toEqual({ unread: 0, starredUnread: 0 });
      await expectNoDrift();
    });
  });

  it("never strands a member in a collection deleted while it was being added to", async () => {
    for (let i = 0; i < 5; i++) {
      const { userId, entryA, collectionId } = await setup();
      const caller = createCaller(await createAuthContext(userId));

      await Promise.allSettled([
        addEntriesToCollection(db, userId, collectionId, [entryA]),
        caller.subscriptions.delete({ id: collectionId }),
      ]);

      expect(
        await db
          .select()
          .from(collectionEntries)
          .where(eq(collectionEntries.subscriptionId, collectionId))
      ).toEqual([]);
    }
  });

  describe("delta sync", () => {
    // An article from an unsubscribed feed is visible only through the
    // collection, so joining or leaving it must reach offline clients.
    /** A sync cursor strictly before anything written after it returns. */
    async function cursorNow(): Promise<string> {
      const now = new Date().toISOString();
      // Writes stamp updated_at with millisecond JS dates; one in the same
      // millisecond as the cursor wouldn't sort after it.
      await new Promise((resolve) => setTimeout(resolve, 2));
      return now;
    }

    async function changesSince(userId: string, since: string) {
      const caller = createCaller(await createAuthContext(userId));
      const result = await caller.sync.changes({ entries: since, entriesSince: since });
      return {
        delivered: result.events.flatMap((e) =>
          e.type === "entry_state_changed" ? [e.entryId] : []
        ),
        hidden: result.deletions.map((d) => d.entryId),
        memberships: result.collectionMemberships,
      };
    }

    /** entryA in the collection, its feed unsubscribed: visible only through it. */
    async function setupCollectedOnly() {
      const world = await setup();
      await addEntriesToCollection(db, world.userId, world.collectionId, [world.entryA]);
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, world.sourceId));
      return world;
    }

    it("re-delivers an article that joins or leaves a collection with its memberships", async () => {
      const { userId, entryA, collectionId } = await setup();
      let since = await cursorNow();

      await addEntriesToCollection(db, userId, collectionId, [entryA]);

      expect(await changesSince(userId, since)).toMatchObject({
        delivered: [entryA],
        memberships: [{ entryId: entryA, subscriptionIds: [collectionId] }],
      });

      since = await cursorNow();
      await removeEntriesFromCollection(db, userId, collectionId, [entryA]);

      // Still visible through its feed, so delivered with no collections.
      expect(await changesSince(userId, since)).toMatchObject({
        delivered: [entryA],
        memberships: [{ entryId: entryA, subscriptionIds: [] }],
      });
    });

    it("syncs a change to an article visible only through a collection as visible", async () => {
      // The sync visibility predicate repeats visible_entries'; without the
      // membership arm this would come back as hidden.
      const { userId, entryA, collectionId } = await setupCollectedOnly();
      const since = await cursorNow();

      await markEntriesRead(db, userId, [{ id: entryA }], true);

      expect(await changesSince(userId, since)).toEqual({
        delivered: [entryA],
        hidden: [],
        memberships: [{ entryId: entryA, subscriptionIds: [collectionId] }],
      });
    });

    it("reports only the user's own collections holding an article", async () => {
      const { userId, feedId, entryA, collectionId } = await setup();
      const otherId = await createTestUser();
      await createTestSubscription(otherId, feedId);
      await db.insert(userEntries).values({ userId: otherId, entryId: entryA });
      const other = await createCollection(db, otherId, "Theirs");
      await addEntriesToCollection(db, otherId, other.subscription.id, [entryA]);
      const since = await cursorNow();

      await addEntriesToCollection(db, userId, collectionId, [entryA]);

      expect((await changesSince(userId, since)).memberships).toEqual([
        { entryId: entryA, subscriptionIds: [collectionId] },
      ]);
    });

    it("reports an article hidden when it leaves its only route into view", async () => {
      const removed = await setupCollectedOnly();
      let since = await cursorNow();
      await removeEntriesFromCollection(db, removed.userId, removed.collectionId, [removed.entryA]);
      expect((await changesSince(removed.userId, since)).hidden).toEqual([removed.entryA]);

      const deleted = await setupCollectedOnly();
      since = await cursorNow();
      await createCaller(await createAuthContext(deleted.userId)).subscriptions.delete({
        id: deleted.collectionId,
      });
      expect((await changesSince(deleted.userId, since)).hidden).toEqual([deleted.entryA]);
    });
  });

  describe("filters", () => {
    it("lists a collection's members and marks only them read", async () => {
      const { userId, entryA, entryB, collectionId } = await setup();
      await addEntriesToCollection(db, userId, collectionId, [entryA]);

      expect(await listIds(userId, { subscriptionId: collectionId })).toEqual([entryA]);

      const { entryIds: marked } = await markAllEntriesRead(db, {
        userId,
        subscriptionId: collectionId,
        showSpam: false,
      });
      expect(marked).toEqual([entryA]);
      const [rowB] = await db
        .select({ read: userEntries.read })
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryB)));
      expect(rowB.read).toBe(false);
    });

    it("a tag holding a feed and a collection lists each article once", async () => {
      const { userId, sourceId, entryA, entryB, collectionId } = await setup();
      const otherFeed = await createTestFeed();
      await createTestSubscription(userId, otherFeed);
      const otherEntry = await createTestEntry(otherFeed, { userIds: [userId] });
      await addEntriesToCollection(db, userId, collectionId, [entryA, otherEntry]);
      const tagId = await createTestTag(userId, { subscriptionIds: [sourceId, collectionId] });

      expect(await listIds(userId, { tagId })).toEqual([entryA, entryB, otherEntry].sort());
    });
  });

  describe("isolation", () => {
    it("skips articles the user can't see", async () => {
      const { userId, collectionId } = await setup();
      const otherUser = await createTestUser();
      const otherFeed = await createTestFeed();
      await createTestSubscription(otherUser, otherFeed);
      const foreignEntry = await createTestEntry(otherFeed, { userIds: [otherUser] });

      const result = await addEntriesToCollection(db, userId, collectionId, [foreignEntry]);

      expect(result.entryIds).toEqual([]);
      expect(await listIds(userId, { subscriptionId: collectionId })).toEqual([]);
    });

    it("rejects another user's collection and plain feed subscriptions", async () => {
      const { userId, sourceId, entryA, collectionId } = await setup();
      const otherUser = await createTestUser();
      const otherCaller = createCaller(await createAuthContext(otherUser));
      const caller = createCaller(await createAuthContext(userId));

      await expect(
        otherCaller.collections.addEntries({ id: collectionId, entryIds: [entryA] })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        caller.collections.addEntries({ id: sourceId, entryIds: [entryA] })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("refuses a membership row pointing at another user's collection", async () => {
      // The other user can see the article too, so only the ownership key
      // (not the user_entries one) can reject the row.
      const { feedId, collectionId, entryA } = await setup();
      const otherUser = await createTestUser();
      await createTestSubscription(otherUser, feedId);
      await db.insert(userEntries).values({ userId: otherUser, entryId: entryA });

      await expect(
        db.insert(collectionEntries).values({
          subscriptionId: collectionId,
          userId: otherUser,
          entryId: entryA,
        })
      ).rejects.toMatchObject({
        cause: { constraint: "collection_entries_subscription_id_user_id_fkey" },
      });
    });

    it("skips an article the user has a row for but can't see", async () => {
      const { userId, sourceId, entryA, collectionId } = await setup();
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date() })
        .where(eq(subscriptions.id, sourceId));

      const result = await addEntriesToCollection(db, userId, collectionId, [entryA]);

      expect(result.entryIds).toEqual([]);
      expect(await getEntries(db, userId, [entryA])).toEqual([]);
    });

    it("rejects adding to a collection that was just deleted", async () => {
      const { userId, entryA, collectionId } = await setup();
      await createCaller(await createAuthContext(userId)).subscriptions.delete({
        id: collectionId,
      });

      await expect(
        addEntriesToCollection(db, userId, collectionId, [entryA])
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("checks a save's collections before saving, and needs a reader scope for them", async () => {
      const { userId, collectionId } = await setup();
      const other = await setup();
      const caller = createCaller(await createAuthContext(userId));
      const html = "<html><head><title>T</title></head><body><p>Body</p></body></html>";

      await expect(
        caller.saved.save({
          url: "https://example.com/a",
          html,
          collectionIds: [other.collectionId],
        })
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(await savedEntryCount(userId)).toBe(0);

      const saveOnly = createCaller({
        ...(await createAuthContext(userId)),
        authType: "api_token",
        scopes: ["saved:write"],
      });
      await expect(
        saveOnly.saved.save({ url: "https://example.com/b", html, collectionIds: [collectionId] })
      ).rejects.toMatchObject({ code: "FORBIDDEN" });

      const { article } = await caller.saved.save({
        url: "https://example.com/c",
        html,
        collectionIds: [collectionId],
      });
      expect(await listIds(userId, { subscriptionId: collectionId })).toEqual([article.id]);
    });
  });

  it("counts a new collection's tags in the affected counts", async () => {
    const { userId, entryA, collectionId } = await setup();
    const tagId = await createTestTag(userId, { subscriptionIds: [collectionId] });

    const { counts } = await addEntriesToCollection(db, userId, collectionId, [entryA]);

    expect(counts?.tags).toEqual([{ id: tagId, unread: 1 }]);
    expect(
      (await getBulkEntryRelatedCounts(db, userId, [{ id: entryA, subscriptionId: null }])).tags
    ).toEqual([{ id: tagId, unread: 1 }]);
  });

  describe("names (#1846)", () => {
    async function collectionIds(userId: string): Promise<string[]> {
      const rows = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, userId), eq(subscriptions.type, "collection")));
      return rows.map((row) => row.id);
    }

    it("returns the existing collection, ignoring case, with its real counts", async () => {
      const { userId, entryA, collectionId } = await setup();
      const tagId = await createTestTag(userId, { subscriptionIds: [collectionId] });
      await addEntriesToCollection(db, userId, collectionId, [entryA]);
      const caller = createCaller(await createAuthContext(userId));

      const again = await caller.collections.create({ name: "research" });

      expect(again).toMatchObject({
        created: false,
        subscription: {
          id: collectionId,
          title: "Research",
          unreadCount: 1,
          tags: [{ id: tagId }],
        },
        counts: { subscriptions: [{ id: collectionId, unread: 1 }] },
      });
      expect(await collectionIds(userId)).toEqual([collectionId]);
    });

    it("gives concurrent creates of one name the same collection", async () => {
      const userId = await createTestUser();

      const results = await Promise.all([
        createCollection(db, userId, "Same"),
        createCollection(db, userId, "same"),
      ]);

      expect(new Set(results.map((r) => r.subscription.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await collectionIds(userId)).toHaveLength(1);
    });

    it("lets a deleted collection's name be reused", async () => {
      const { userId, collectionId } = await setup();
      const caller = createCaller(await createAuthContext(userId));
      await caller.subscriptions.delete({ id: collectionId });

      const again = await caller.collections.create({ name: "Research" });

      expect(again.created).toBe(true);
      expect(again.subscription.id).not.toBe(collectionId);
    });

    it("refuses renaming a collection onto another's name, ignoring case", async () => {
      const { userId, collectionId } = await setup();
      await createCollection(db, userId, "Reading");
      const caller = createCaller(await createAuthContext(userId));

      await expect(
        caller.subscriptions.update({ id: collectionId, customTitle: " reading " })
      ).rejects.toMatchObject({
        code: "CONFLICT",
        message: "A collection with this name already exists",
      });
    });

    it("allows renaming a collection to another capitalization of its own name", async () => {
      const { userId, collectionId } = await setup();
      const caller = createCaller(await createAuthContext(userId));

      const result = await caller.subscriptions.update({
        id: collectionId,
        customTitle: "RESEARCH",
      });

      expect(result.title).toBe("RESEARCH");
    });

    it.each([null, "", "  "])("refuses clearing a collection's name (%j)", async (customTitle) => {
      const { userId, collectionId } = await setup();
      const caller = createCaller(await createAuthContext(userId));

      await expect(
        caller.subscriptions.update({ id: collectionId, customTitle })
      ).rejects.toMatchObject({ code: "BAD_REQUEST" });
      expect((await caller.subscriptions.get({ id: collectionId })).title).toBe("Research");
    });

    it("lets a feed take a collection's name", async () => {
      const { userId, sourceId } = await setup();
      const caller = createCaller(await createAuthContext(userId));

      const result = await caller.subscriptions.update({ id: sourceId, customTitle: "research" });

      expect(result.title).toBe("research");
    });

    it("the migration renames clashes, fills every name and requires one", async () => {
      // As the release before 0128's code creates them: the name only on the
      // feed. They're inserted with a placeholder name (the constraint
      // requires one) that the transaction below clears.
      const at = (minutes: number) => new Date(Date.UTC(2026, 9, 1, 0, minutes));
      const create = async (
        userId: string,
        title: string | null,
        createdAt: Date,
        {
          stored = false,
          unsubscribedAt = null,
        }: { stored?: boolean; unsubscribedAt?: Date | null } = {}
      ) => {
        const feedId = await createTestFeed({ type: "collection", userId, url: null, title });
        const id = await createTestSubscription(userId, feedId, {
          customTitle: stored ? title : `placeholder ${feedId}`,
          createdAt,
          updatedAt: createdAt,
          unsubscribedAt,
        });
        return { id, stored };
      };
      const userId = await createTestUser();
      const otherUserId = await createTestUser();
      const rows = {
        // A stored name keeps it even against an older unstored one.
        oldNews: await create(userId, "news", at(1)),
        news: await create(userId, "News", at(2), { stored: true }),
        news2: await create(userId, "NEWS (2)", at(3), { stored: true }),
        // Without a stored name, the oldest keeps it.
        reading: await create(userId, "Reading", at(4)),
        newReading: await create(userId, "READING", at(5)),
        deleted: await create(userId, "News", at(6), { unsubscribedAt: at(7) }),
        otherUser: await create(otherUserId, "News", at(8)),
        // No name anywhere: "Untitled", and a second one doesn't clash with it.
        untitled: await create(otherUserId, null, at(10)),
        untitled2: await create(otherUserId, null, at(11)),
      };
      const feed = await createTestSubscription(userId, await createTestFeed(), {
        createdAt: at(9),
        updatedAt: at(9),
      });
      const migration = readFileSync(
        new URL("../../migrations/0129_collection_names_required.sql", import.meta.url),
        "utf8"
      );
      const unstored = Object.values(rows)
        .filter((row) => !row.stored)
        .map((row) => row.id);

      // Run it against the old-style rows, then roll back to the migrated schema.
      let after: { id: string; customTitle: string | null; updatedAt: Date }[] = [];
      await expect(
        db.transaction(async (tx) => {
          await tx.execute(
            sql`ALTER TABLE subscriptions DROP CONSTRAINT subscriptions_collection_named`
          );
          await tx
            .update(subscriptions)
            .set({ customTitle: null })
            .where(inArray(subscriptions.id, unstored));
          await tx.execute(sql.raw(migration));
          after = await tx
            .select({
              id: subscriptions.id,
              customTitle: subscriptions.customTitle,
              updatedAt: subscriptions.updatedAt,
            })
            .from(subscriptions)
            .where(inArray(subscriptions.userId, [userId, otherUserId]));
          tx.rollback();
        })
      ).rejects.toThrow(TransactionRollbackError);

      expect(new Map(after.map((r) => [r.id, r.customTitle]))).toEqual(
        new Map([
          [rows.oldNews.id, "news (3)"],
          [rows.news.id, "News"],
          [rows.news2.id, "NEWS (2)"],
          [rows.reading.id, "Reading"],
          [rows.newReading.id, "READING (2)"],
          [rows.deleted.id, "News"],
          [rows.otherUser.id, "News"],
          [rows.untitled.id, "Untitled"],
          [rows.untitled2.id, "Untitled (2)"],
          [feed, null],
        ])
      );
      // Delta sync re-delivers exactly the renamed ones.
      const moved = after.filter((r) => r.updatedAt.getTime() > at(60).getTime()).map((r) => r.id);
      expect(moved.sort()).toEqual([rows.oldNews.id, rows.newReading.id, rows.untitled2.id].sort());
      await expect(
        db
          .update(subscriptions)
          .set({ customTitle: null })
          .where(eq(subscriptions.id, rows.reading.id))
      ).rejects.toMatchObject({ cause: { constraint: "subscriptions_collection_named" } });
    });
  });
});
