/**
 * `subscription_entries` (#1846): every write path adds an article's
 * memberships itself (its source, a collection, or the user's saved
 * subscription for a saved article). The previous release still writes the
 * older forms, which mirror triggers copy, so each write path runs with the
 * mirror triggers on (both releases during a rollout: each membership counted
 * once) and off (this release alone). Also the saved subscription a first save
 * creates, the backfill script and the daily check against the older forms.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, pool } from "../../src/server/db";
import {
  entries,
  feeds,
  jobs,
  subscriptionEntries,
  subscriptionTags,
  subscriptions,
  tags,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createUserEntriesForFeed } from "../../src/server/feed/entry-processor";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import {
  addEntriesToCollection,
  createCollection,
  removeEntriesFromCollection,
} from "../../src/server/services/collections";
import {
  createSubscription,
  mergeSubscriptionIntoFeed,
  unsubscribe,
} from "../../src/server/services/subscriptions";
import { uploadArticle } from "../../src/server/services/saved";
import { checkSubscriptionEntries } from "../../src/server/services/subscription-entries";
import { getGlobalUnreadCounts } from "../../src/server/services/counts";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";
import { backfillSubscriptionEntries } from "../../scripts/backfill-subscription-entries";
import {
  createTestEntry,
  createTestFeed,
  createTestIngestAddress,
  createTestSubscription,
  createTestUser,
  setMembershipMirror,
} from "./helpers";

const CONSISTENT = { missing: 0, extra: 0, misdated: 0 };
const NO_FIXES = { userEntriesFixed: 0, subscriptionsFixed: 0, usersFixed: 0, tagsFixed: 0 };

async function cleanup(): Promise<void> {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionTags);
  await db.delete(tags);
  await db.delete(subscriptions);
  await db.delete(jobs);
  await db.delete(feeds);
  await db.delete(users);
}

/** The user's memberships as sorted "subscriptionId entryId" pairs. */
async function membershipsOf(userId: string): Promise<string[]> {
  const rows = await db
    .select({ s: subscriptionEntries.subscriptionId, e: subscriptionEntries.entryId })
    .from(subscriptionEntries)
    .where(eq(subscriptionEntries.userId, userId));
  return rows.map((r) => `${r.s} ${r.e}`).sort();
}

function pairs(...memberships: Array<[string, string]>): string[] {
  return memberships.map(([s, e]) => `${s} ${e}`).sort();
}

async function savedSubscriptionsOf(userId: string) {
  return db
    .select({
      id: subscriptions.id,
      feedId: subscriptions.feedId,
      customTitle: subscriptions.customTitle,
      greaderStreamId: subscriptions.greaderStreamId,
      unsubscribedAt: subscriptions.unsubscribedAt,
    })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.type, "saved")));
}

async function feedRow(feedId: string) {
  const [row] = await db.select().from(feeds).where(eq(feeds.id, feedId));
  return row;
}

/** A web feed whose current document (per `last_entries_updated_at`) holds `count` entries. */
async function currentFeed(count: number): Promise<{ feedId: string; entryIds: string[] }> {
  const feedId = await createTestFeed({ lastEntriesUpdatedAt: new Date(Date.now() - 60_000) });
  const entryIds: string[] = [];
  for (let i = 0; i < count; i++) entryIds.push(await createTestEntry(feedId));
  return { feedId, entryIds };
}

describe.each([
  ["on", true],
  ["off", false],
])("write paths, mirror triggers %s (#1846)", (_, mirror) => {
  beforeAll(() => setMembershipMirror(mirror));
  beforeEach(cleanup);
  // Every write path below keeps the counters exact and the previous
  // release's forms matching.
  afterEach(async () => {
    expect(await reconcileCounters(db)).toEqual(NO_FIXES);
    expect(await checkSubscriptionEntries(db)).toEqual(CONSISTENT);
  });
  afterAll(async () => {
    await setMembershipMirror(true);
    await cleanup();
  });

  it("adds a fetch's fan-out to each subscriber, idempotently", async () => {
    const [alice, bob] = [await createTestUser(), await createTestUser()];
    const { feedId, entryIds } = await currentFeed(2);
    const aliceSub = await createTestSubscription(alice, feedId);
    const bobSub = await createTestSubscription(bob, feedId);

    await createUserEntriesForFeed(feedId, entryIds);
    await createUserEntriesForFeed(feedId, entryIds);

    expect(await membershipsOf(alice)).toEqual(
      pairs([aliceSub, entryIds[0]], [aliceSub, entryIds[1]])
    );
    expect(await membershipsOf(bob)).toEqual(pairs([bobSub, entryIds[0]], [bobSub, entryIds[1]]));
  });

  it("adds a new subscription's initial entries", async () => {
    const userId = await createTestUser();
    const { feedId, entryIds } = await currentFeed(2);

    const { subscriptionId } = await createSubscription(db, userId, {
      url: (await feedRow(feedId)).url!,
    });

    expect(await membershipsOf(userId)).toEqual(
      pairs([subscriptionId, entryIds[0]], [subscriptionId, entryIds[1]])
    );
  });

  it("adds a redirect merge's survivor and keeps the old subscription's", async () => {
    const userId = await createTestUser();
    const oldFeedId = await createTestFeed();
    const oldSub = await createTestSubscription(userId, oldFeedId);
    const entryId = await createTestEntry(oldFeedId, { userIds: [userId] });
    const newFeedId = await createTestFeed();

    await mergeSubscriptionIntoFeed(db, userId, oldSub, await feedRow(newFeedId));

    const [{ id: survivor }] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, newFeedId)));
    expect(await membershipsOf(userId)).toEqual(pairs([oldSub, entryId], [survivor, entryId]));
  });

  it("skips the new feed's copy of an article a merge put in the survivor", async () => {
    const userId = await createTestUser();
    const oldFeedId = await createTestFeed();
    const oldSub = await createTestSubscription(userId, oldFeedId);
    const article = await createTestEntry(oldFeedId, {
      guid: "http://example.com/a",
      userIds: [userId],
    });
    const newFeedId = await createTestFeed();
    await mergeSubscriptionIntoFeed(db, userId, oldSub, await feedRow(newFeedId));
    const twin = await createTestEntry(newFeedId, { guid: "https://example.com/a" });
    const fresh = await createTestEntry(newFeedId);

    await createUserEntriesForFeed(newFeedId, [twin, fresh]);

    const [{ id: survivor }] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, newFeedId)));
    expect(await membershipsOf(userId)).toEqual(
      pairs([oldSub, article], [survivor, article], [survivor, fresh])
    );
  });

  it("follows collection adds and removals, and keeps a deleted collection's", async () => {
    const userId = await createTestUser();
    const feedId = await createTestFeed();
    const sourceId = await createTestSubscription(userId, feedId);
    const [a, b] = [
      await createTestEntry(feedId, { userIds: [userId] }),
      await createTestEntry(feedId, { userIds: [userId] }),
    ];
    const reading = (await createCollection(db, userId, "Reading")).subscription.id;
    const later = (await createCollection(db, userId, "Later")).subscription.id;

    await addEntriesToCollection(db, userId, reading, [a, b]);
    await addEntriesToCollection(db, userId, reading, [a]);
    await addEntriesToCollection(db, userId, later, [a]);
    await removeEntriesFromCollection(db, userId, reading, [b]);
    expect(await membershipsOf(userId)).toEqual(
      pairs([sourceId, a], [sourceId, b], [reading, a], [later, a])
    );

    await unsubscribe(db, userId, later);
    expect(await membershipsOf(userId)).toEqual(
      pairs([sourceId, a], [sourceId, b], [reading, a], [later, a])
    );
  });

  it("puts saved articles in the saved subscription, created on the first save", async () => {
    const userId = await createTestUser();

    const first = await uploadArticle(db, userId, { content: "# One\n\nBody", title: "" });
    const second = await uploadArticle(db, userId, { content: "# Two\n\nBody", title: "" });

    const saved = await savedSubscriptionsOf(userId);
    expect(saved).toEqual([
      {
        id: expect.any(String),
        feedId: null,
        customTitle: "Saved",
        greaderStreamId: expect.any(BigInt),
        unsubscribedAt: null,
      },
    ]);
    expect(await membershipsOf(userId)).toEqual(
      pairs([saved[0].id, first.id], [saved[0].id, second.id])
    );
    expect(await getGlobalUnreadCounts(db, userId)).toMatchObject({ savedUnread: 2, allUnread: 2 });
  });

  it("creates one saved subscription when two first saves race", async () => {
    const userId = await createTestUser();
    const held = await pool.connect();
    const heldEntryId = generateUuidv7();
    try {
      // The first save creates the saved subscription and stays open: the
      // previous release's (whose mirror trigger creates it) or this one's...
      await held.query("BEGIN");
      await held.query(
        `INSERT INTO entries (id, owner_user_id, type, guid, content_hash, fetched_at)
         VALUES ($1, $2, 'saved', $3, $3, now())`,
        [heldEntryId, userId, `guid-${heldEntryId}`]
      );
      if (!mirror) {
        await held.query("SELECT ensure_saved_subscriptions(ARRAY[$1::uuid])", [userId]);
      }
      await held.query("INSERT INTO user_entries (user_id, entry_id) VALUES ($1, $2)", [
        userId,
        heldEntryId,
      ]);
      if (!mirror) {
        await held.query(
          `INSERT INTO subscription_entries (subscription_id, user_id, entry_id, published_or_fetched_at)
           SELECT s.id, ue.user_id, ue.entry_id, ue.published_or_fetched_at
           FROM user_entries ue JOIN subscriptions s ON s.user_id = ue.user_id AND s.type = 'saved'
           WHERE ue.user_id = $1 AND ue.entry_id = $2`,
          [userId, heldEntryId]
        );
      }
      // ...so the second waits on the saved subscription's unique index.
      const second = uploadArticle(db, userId, { content: "# Two\n\nBody", title: "" });
      await expect
        .poll(
          async () =>
            (
              await db.execute<{ n: number }>(sql`
                SELECT count(*)::int AS n FROM pg_stat_activity
                WHERE datname = current_database() AND wait_event_type = 'Lock'
              `)
            ).rows[0].n
        )
        .toBe(1);
      await held.query("COMMIT");
      const { id: secondEntryId } = await second;

      const saved = await savedSubscriptionsOf(userId);
      expect(saved).toHaveLength(1);
      expect(await membershipsOf(userId)).toEqual(
        pairs([saved[0].id, heldEntryId], [saved[0].id, secondEntryId])
      );
    } finally {
      await held.query("ROLLBACK");
      held.release();
    }
  });

  it("adds an email's entry to its email subscription", async () => {
    const userId = await createTestUser();
    const token = `token-${generateUuidv7()}`;
    await createTestIngestAddress(userId, { token });

    const result = await processInboundEmail({
      to: `${token}@ingest.lionreader.com`,
      from: { address: "news@example.com", name: "News" },
      subject: "Hello",
      messageId: `<${generateUuidv7()}@example.com>`,
      html: "<p>Hi</p>",
      headers: {},
    });

    expect(result.success).toBe(true);
    const [{ id: emailSub }] = await db
      .select({ id: subscriptions.id })
      .from(subscriptions)
      .where(and(eq(subscriptions.userId, userId), eq(subscriptions.type, "email")));
    expect(await membershipsOf(userId)).toEqual(pairs([emailSub, result.entryId!]));
  });
});

describe("subscription_entries foreign keys (#1846)", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("can't hold another user's subscription or article", async () => {
    const [alice, bob] = [await createTestUser(), await createTestUser()];
    const feedId = await createTestFeed();
    const aliceSub = await createTestSubscription(alice, feedId);
    await createTestSubscription(bob, feedId);
    const bobsOnly = await createTestEntry(feedId, { userIds: [bob] });
    const insert = (userId: string) =>
      db.insert(subscriptionEntries).values({
        subscriptionId: aliceSub,
        userId,
        entryId: bobsOnly,
        publishedOrFetchedAt: sql`now()`,
      });

    // As Bob: the subscription isn't his. As Alice: she has no such article.
    await expect(insert(bob)).rejects.toMatchObject({ cause: { code: "23503" } });
    await expect(insert(alice)).rejects.toMatchObject({ cause: { code: "23503" } });
  });
});

describe("backfill and check (#1846)", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  /**
   * The user's memberships with the saved subscription named by its type, since
   * the backfill recreates it with a new id.
   */
  async function membershipsByKind(userId: string): Promise<string[]> {
    const rows = await db
      .select({
        s: subscriptionEntries.subscriptionId,
        type: subscriptions.type,
        e: subscriptionEntries.entryId,
      })
      .from(subscriptionEntries)
      .innerJoin(subscriptions, eq(subscriptions.id, subscriptionEntries.subscriptionId))
      .where(eq(subscriptionEntries.userId, userId));
    return rows.map((r) => `${r.type === "saved" ? "saved" : r.s} ${r.e}`).sort();
  }

  /** One of each membership kind, then the copy wiped as before the migration. */
  async function oldForms() {
    const userId = await createTestUser();
    const feedId = await createTestFeed();
    const sourceId = await createTestSubscription(userId, feedId);
    const entryIds = [
      await createTestEntry(feedId, { userIds: [userId] }),
      await createTestEntry(feedId, { userIds: [userId] }),
      await createTestEntry(feedId, { userIds: [userId] }),
    ];
    const collectionId = (await createCollection(db, userId, "Reading")).subscription.id;
    await addEntriesToCollection(db, userId, collectionId, [entryIds[0]]);
    const savedId = (await uploadArticle(db, userId, { content: "# Saved\n\nBody", title: "" })).id;
    const expected = await membershipsByKind(userId);
    await db.delete(subscriptionEntries);
    await db.delete(subscriptions).where(eq(subscriptions.type, "saved"));
    return { userId, sourceId, collectionId, savedId, entryIds, expected };
  }

  it("rebuilds every membership in batches, and re-running adds nothing", async () => {
    const { userId, expected } = await oldForms();
    expect(expected).toHaveLength(5);
    expect(await checkSubscriptionEntries(db)).toEqual({ ...CONSISTENT, missing: 5 });

    expect(await backfillSubscriptionEntries(db, { batchSize: 2 })).toEqual({
      savedSubscriptionsCreated: 1,
      userEntryMemberships: 4,
      collectionMemberships: 1,
    });
    expect(await membershipsByKind(userId)).toEqual(expected);
    expect(await checkSubscriptionEntries(db)).toEqual(CONSISTENT);

    expect(await backfillSubscriptionEntries(db, { batchSize: 2 })).toEqual({
      savedSubscriptionsCreated: 0,
      userEntryMemberships: 0,
      collectionMemberships: 0,
    });
  });

  it("resumes the user_entries walk after a cursor", async () => {
    const { userId, collectionId } = await oldForms();
    const rows = await db
      .select({ entryId: userEntries.entryId })
      .from(userEntries)
      .where(eq(userEntries.userId, userId))
      .orderBy(userEntries.entryId);

    await backfillSubscriptionEntries(db, { after: { userId, entryId: rows[1].entryId } });

    const walked = (await membershipsOf(userId))
      .filter((m) => !m.startsWith(collectionId))
      .map((m) => m.split(" ")[1])
      .sort();
    expect(walked).toEqual(rows.slice(2).map((r) => r.entryId));
  });

  it("reports missing, unexplained and misdated memberships", async () => {
    const { userId, sourceId, collectionId, entryIds } = await oldForms();
    await backfillSubscriptionEntries(db);

    await db
      .delete(subscriptionEntries)
      .where(
        and(
          eq(subscriptionEntries.subscriptionId, sourceId),
          eq(subscriptionEntries.entryId, entryIds[1])
        )
      );
    // In the collection without a collection_entries row, and in another
    // active web subscription whose feed it isn't from.
    const otherFeedSub = await createTestSubscription(userId, await createTestFeed());
    for (const subscriptionId of [collectionId, otherFeedSub]) {
      await db.insert(subscriptionEntries).values({
        subscriptionId,
        userId,
        entryId: entryIds[2],
        publishedOrFetchedAt: sql`(SELECT published_or_fetched_at FROM user_entries WHERE user_id = ${userId} AND entry_id = ${entryIds[2]})`,
      });
    }
    await db
      .update(subscriptionEntries)
      .set({ publishedOrFetchedAt: sql`published_or_fetched_at - interval '1 second'` })
      .where(
        and(
          eq(subscriptionEntries.subscriptionId, sourceId),
          eq(subscriptionEntries.entryId, entryIds[0])
        )
      );

    expect(await checkSubscriptionEntries(db)).toEqual({ missing: 1, extra: 2, misdated: 1 });
  });
});
