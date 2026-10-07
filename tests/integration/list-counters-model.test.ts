/**
 * Randomized model test for the unread counters (#1806).
 *
 * Runs seeded random sequences of the operations that move counters — read,
 * star, collection membership, tagging, unsubscribing and resubscribing, feed
 * merges (onto a new feed, and onto one the user already follows), spam, new
 * articles (one by one, and a fan-out to every user of a shared feed),
 * newsletters through the ingest path with unsubscribing and resubscribing,
 * saving (upload and by URL, including a user's first save) and deleting saved
 * articles, deleting feeds, mark-all-read, statements moving rows both ways,
 * deleting tags, collections and users — through the code the app runs. After every step it checks that:
 *   1. every counter and the set of visible articles equal what #1846's rules
 *      give, computed here from the base facts (memberships, subscriptions,
 *      tags, read/starred/spam) rather than through any app or trigger code
 *      (`expectedState`),
 *   2. the reconcile job, which recomputes every counter from its definition,
 *      finds nothing to fix,
 *   3. every badge equals the number of unread articles its list shows (tag,
 *      Uncategorized, each subscription, All, Starred, Saved), and
 *   4. the subscription_entries mirror matches the memberships it copies (#1846).
 * Interleavings that hand-written tests miss (an article reaching a tag through
 * both its feed and a collection, retagging while members are unread, ...)
 * come up here. Every random pick indexes a world's ids in creation order, so
 * a seed replays the same operations; a failure prints the seed and step.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  blockedSenders,
  collectionEntries,
  entries,
  feeds,
  subscriptionEntries,
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
  countEntries,
  listEntries,
  markAllEntriesRead,
  markEntriesRead,
  updateEntryStarred,
} from "../../src/server/services/entries";
import { createSubscription, setSubscriptionTags } from "../../src/server/services/subscriptions";
import { migrateSubscriptionsToExistingFeed } from "../../src/server/jobs/handlers/fetch-feed";
import { deleteTag } from "../../src/server/services/tags";
import { deleteSavedArticle, saveArticle, uploadArticle } from "../../src/server/services/saved";
import { createUserEntriesForFeed } from "../../src/server/feed/entry-processor";
import { processInboundEmail } from "../../src/server/email/process-inbound";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { reconcileCounters } from "../../src/server/services/reconcile-counters";
import { checkSubscriptionEntries } from "../../src/server/services/subscription-entries";
import { createCaller } from "../../src/server/trpc/root";
import {
  createAuthContext,
  createTestEntry,
  createTestIngestAddress,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

const STEPS = 150;
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** mulberry32: small seeded PRNG so failures replay exactly. */
function prng(seed: number) {
  let a = seed;
  const next = () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    pick<T>(items: T[]): T {
      return items[Math.floor(next() * items.length)];
    },
    chance: (p: number) => next() < p,
  };
}

async function cleanup(): Promise<void> {
  await db.delete(blockedSenders);
  await db.delete(collectionEntries);
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionTags);
  await db.delete(tags);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

/** One user's ids, each list in creation order. */
interface World {
  userId: string;
  feeds: Array<{ feedId: string; subscriptionId: string }>;
  emailSubscriptionId: string;
  /** The ingest token newsletters are delivered to (processInboundEmail). */
  ingestToken: string;
  collections: string[];
  tagIds: string[];
  entryIds: string[];
  savedIds: string[];
}

/**
 * A feed every world subscribes to, so one fan-out statement inserts rows for
 * several users (set per seed).
 */
let sharedFeedId = "";
/** The current worlds, for operations that reach every user. */
let currentWorlds: World[] = [];

/** The world's feeds other than the shared one. */
function ownFeeds(w: World): World["feeds"] {
  return w.feeds.filter((f) => f.feedId !== sharedFeedId);
}

async function createWorld({ withSaved }: { withSaved: boolean }): Promise<World> {
  const userId = await createTestUser();
  const ingestToken = `token-${generateUuidv7()}`;
  await createTestIngestAddress(userId, { token: ingestToken });
  const world: World = {
    userId,
    feeds: [],
    emailSubscriptionId: "",
    ingestToken,
    collections: [],
    tagIds: [],
    entryIds: [],
    savedIds: [],
  };
  world.feeds.push({
    feedId: sharedFeedId,
    subscriptionId: await createTestSubscription(userId, sharedFeedId),
  });
  for (let i = 0; i < 3; i++) {
    const feedId = await createTestFeed();
    const subscriptionId = await createTestSubscription(userId, feedId);
    world.feeds.push({ feedId, subscriptionId });
    for (let j = 0; j < 4; j++) {
      world.entryIds.push(await createTestEntry(feedId, { userIds: [userId] }));
    }
  }
  for (let i = 0; i < 2; i++) {
    world.collections.push((await createCollection(db, userId, `C${i}`)).subscription.id);
  }
  for (let i = 0; i < 2; i++) world.tagIds.push(await createTestTag(userId));
  // Newsletters, the only source of spam (set once, at insert).
  const emailFeedId = await createTestFeed({
    type: "email",
    url: null,
    userId,
    emailSenderPattern: `news-${userId}@example.com`,
  });
  world.emailSubscriptionId = await createTestSubscription(userId, emailFeedId);
  for (const isSpam of [true, false, true]) {
    world.entryIds.push(
      await createTestEntry(emailFeedId, { type: "email", isSpam, userIds: [userId] })
    );
  }
  // The other world's first save comes later, creating its saved subscription.
  for (let i = 0; withSaved && i < 2; i++) {
    const { id } = await uploadArticle(db, userId, { content: "x", title: `S${i}` });
    world.savedIds.push(id);
    world.entryIds.push(id);
  }
  return world;
}

async function visibleEntryIds(w: World): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(
    sql`SELECT id FROM visible_entries WHERE user_id = ${w.userId}`
  );
  const visible = new Set(rows.rows.map((r) => r.id));
  return w.entryIds.filter((id) => visible.has(id));
}

async function activeSubscriptionIds(w: World): Promise<string[]> {
  const rows = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, w.userId), isNull(subscriptions.unsubscribedAt)));
  const active = new Set(rows.map((r) => r.id));
  return [...w.feeds.map((f) => f.subscriptionId), w.emailSubscriptionId, ...w.collections].filter(
    (id) => active.has(id)
  );
}

async function liveTagIds(w: World): Promise<string[]> {
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.userId, w.userId), isNull(tags.deletedAt)));
  const live = new Set(rows.map((r) => r.id));
  return w.tagIds.filter((id) => live.has(id));
}

async function membershipCount(subscriptionId: string): Promise<number> {
  const [{ n }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(subscriptionEntries)
    .where(eq(subscriptionEntries.subscriptionId, subscriptionId));
  return n;
}

/**
 * Where today's triggers differ from #1846's rules; phase 5 makes them agree
 * and deletes these.
 */
const TODAY = {
  /** Deleting a collection empties it, instead of keeping its memberships. */
  deletedCollectionsEmptied: true,
};

interface ExpectedState {
  visible: string[];
  /** Each article's `user_entries.active_memberships`. */
  activeMemberships: Map<string, number>;
  subscriptions: Map<string, number>;
  tags: Map<string, number>;
  all: number;
  uncategorized: number;
  starred: number;
  saved: number;
}

/**
 * Every counter and the visible articles of one user, by #1846's rules,
 * from the base facts alone:
 * - visible: starred, or in at least one active subscription (the number of
 *   which is the row's `active_memberships`);
 * - a subscription (active or not): its unread, non-spam memberships;
 * - All: visible, unread, non-spam articles;
 * - a tag: distinct unread, non-spam articles in an active subscription with
 *   that tag; Uncategorized: the same for untagged subscriptions other than
 *   saved;
 * - Starred: starred, unread, non-spam articles; Saved: the saved
 *   subscription's count.
 */
async function expectedState(userId: string): Promise<ExpectedState> {
  const subs = await db
    .select({
      id: subscriptions.id,
      type: subscriptions.type,
      active: sql<boolean>`${subscriptions.unsubscribedAt} IS NULL`,
    })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  const tagRows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));
  const tagLinks = await db
    .select({ subscriptionId: subscriptionTags.subscriptionId, tagId: subscriptionTags.tagId })
    .from(subscriptionTags)
    .innerJoin(subscriptions, eq(subscriptions.id, subscriptionTags.subscriptionId))
    .where(eq(subscriptions.userId, userId));
  const memberships = await db
    .select({
      subscriptionId: subscriptionEntries.subscriptionId,
      entryId: subscriptionEntries.entryId,
    })
    .from(subscriptionEntries)
    .where(eq(subscriptionEntries.userId, userId));
  const rows = await db
    .select({
      entryId: userEntries.entryId,
      read: userEntries.read,
      starred: userEntries.starred,
      isSpam: userEntries.isSpam,
    })
    .from(userEntries)
    .where(eq(userEntries.userId, userId));

  const row = new Map(rows.map((r) => [r.entryId, r]));
  const unread = (entryId: string) => !row.get(entryId)!.read && !row.get(entryId)!.isSpam;
  const membersOf = (subscriptionId: string) =>
    memberships.filter((m) => m.subscriptionId === subscriptionId).map((m) => m.entryId);
  const tagsOf = (subscriptionId: string) =>
    tagLinks.filter((l) => l.subscriptionId === subscriptionId).map((l) => l.tagId);
  const active = subs.filter((s) => s.active);
  const distinctUnread = (inLists: typeof subs) =>
    new Set(inLists.flatMap((s) => membersOf(s.id)).filter(unread)).size;

  const activeMemberships = new Map<string, number>(rows.map((r) => [r.entryId, 0]));
  for (const s of active) {
    for (const id of membersOf(s.id)) activeMemberships.set(id, activeMemberships.get(id)! + 1);
  }
  const visible = rows
    .filter((r) => r.starred || activeMemberships.get(r.entryId)! > 0)
    .map((r) => r.entryId)
    .sort();
  const savedSubscription = subs.find((s) => s.type === "saved");

  return {
    visible,
    activeMemberships,
    subscriptions: new Map(subs.map((s) => [s.id, membersOf(s.id).filter(unread).length])),
    tags: new Map(
      tagRows.map((t) => [t.id, distinctUnread(active.filter((s) => tagsOf(s.id).includes(t.id)))])
    ),
    all: visible.filter(unread).length,
    uncategorized: distinctUnread(
      active.filter((s) => s.type !== "saved" && tagsOf(s.id).length === 0)
    ),
    starred: rows.filter((r) => r.starred && unread(r.entryId)).length,
    saved: savedSubscription ? membersOf(savedSubscription.id).filter(unread).length : 0,
  };
}

/** Every counter, and the visible articles, must be what #1846's rules give. */
async function expectCountersMatchModel(userId: string, context: string): Promise<void> {
  const expected = await expectedState(userId);
  const visible = await db.execute<{ id: string }>(
    sql`SELECT id FROM visible_entries WHERE user_id = ${userId} ORDER BY id`
  );
  expect(
    visible.rows.map((r) => r.id),
    `${context}\nvisible`
  ).toEqual(expected.visible);

  const memberships = await db
    .select({ id: userEntries.entryId, n: userEntries.activeMemberships })
    .from(userEntries)
    .where(eq(userEntries.userId, userId));
  expect(new Map(memberships.map((r) => [r.id, r.n])), `${context}\nactive_memberships`).toEqual(
    expected.activeMemberships
  );

  const [user] = await db
    .select({
      all: users.allUnreadCount,
      uncategorized: users.uncategorizedUnreadCount,
      starred: users.starredUnreadCount,
      saved: users.savedUnreadCount,
    })
    .from(users)
    .where(eq(users.id, userId));
  expect(user, `${context}\nuser counters`).toEqual({
    all: expected.all,
    uncategorized: expected.uncategorized,
    starred: expected.starred,
    saved: expected.saved,
  });

  const subscriptionCounts = await db
    .select({ id: subscriptions.id, unread: subscriptions.unreadCount })
    .from(subscriptions)
    .where(eq(subscriptions.userId, userId));
  expect(
    new Map(subscriptionCounts.map((s) => [s.id, s.unread])),
    `${context}\nsubscription counters`
  ).toEqual(expected.subscriptions);

  const tagCounts = await db
    .select({ id: tags.id, unread: tags.unreadCount })
    .from(tags)
    .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)));
  expect(new Map(tagCounts.map((t) => [t.id, t.unread])), `${context}\ntag counters`).toEqual(
    expected.tags
  );
}

type Op = (world: World, rng: ReturnType<typeof prng>) => Promise<string>;

/**
 * After a merge, the survivor takes the merged-away subscription's place
 * everywhere, so later steps never resubscribe to a feed that redirects.
 */
function replaceFeed(w: World, subscriptionId: string, survivor: World["feeds"][number]): void {
  w.feeds = w.feeds.map((f) => (f.subscriptionId === subscriptionId ? survivor : f));
}

const OPS: Array<[number, Op]> = [
  [
    6,
    async (w, rng) => {
      const id = rng.pick(await visibleEntryIds(w));
      if (!id) return "read: nothing visible";
      const read = rng.chance(0.6);
      await markEntriesRead(db, w.userId, [{ id }], read);
      return `${read ? "read" : "unread"} ${id}`;
    },
  ],
  [
    3,
    async (w, rng) => {
      const id = rng.pick(await visibleEntryIds(w));
      if (!id) return "star: nothing visible";
      const starred = rng.chance(0.5);
      await updateEntryStarred(db, w.userId, id, starred);
      return `${starred ? "star" : "unstar"} ${id}`;
    },
  ],
  [
    5,
    async (w, rng) => {
      const active = new Set(await activeSubscriptionIds(w));
      const collection = rng.pick(w.collections.filter((c) => active.has(c)));
      const id = rng.pick(await visibleEntryIds(w));
      if (!collection || !id) return "add: nothing to add";
      if (rng.chance(0.65)) {
        await addEntriesToCollection(db, w.userId, collection, [id]);
        return `add ${id} to ${collection}`;
      }
      await removeEntriesFromCollection(db, w.userId, collection, [id]);
      return `remove ${id} from ${collection}`;
    },
  ],
  [
    4,
    async (w, rng) => {
      const sub = rng.pick(await activeSubscriptionIds(w));
      const live = await liveTagIds(w);
      const tagIds = live.filter(() => rng.chance(0.6));
      await setSubscriptionTags(db, w.userId, sub, tagIds);
      return `tag ${sub} with [${tagIds.join(",")}]`;
    },
  ],
  [
    2,
    async (w, rng) => {
      const feed = rng.pick(w.feeds);
      const active = (await activeSubscriptionIds(w)).includes(feed.subscriptionId);
      if (active) {
        // What the unsubscribe paths do: drop the tags, then soft-delete.
        await createCaller(await createAuthContext(w.userId)).subscriptions.delete({
          id: feed.subscriptionId,
        });
        return `unsubscribe ${feed.subscriptionId}`;
      }
      const [{ url }] = await db
        .select({ url: feeds.url })
        .from(feeds)
        .where(eq(feeds.id, feed.feedId));
      await createSubscription(db, w.userId, { url: url! });
      return `resubscribe ${feed.subscriptionId}`;
    },
  ],
  [
    2,
    async (w, rng) => {
      const feed = rng.pick(w.feeds);
      const active = (await activeSubscriptionIds(w)).includes(feed.subscriptionId);
      if (!active) return "new entry: feed inactive";
      const id = await createTestEntry(feed.feedId, { userIds: [w.userId] });
      w.entryIds.push(id);
      return `new entry ${id} in ${feed.subscriptionId}`;
    },
  ],
  [
    1,
    async (w, rng) => {
      if (rng.chance(0.5) && w.savedIds.length > 0) {
        const id = w.savedIds.pop()!;
        await deleteSavedArticle(db, w.userId, id);
        return `delete saved ${id}`;
      }
      if (rng.chance(0.5)) {
        const article = await uploadArticle(db, w.userId, { content: "y", title: "New" });
        w.savedIds.push(article.id);
        w.entryIds.push(article.id);
        return `upload ${article.id}`;
      }
      const article = await saveArticle(db, w.userId, {
        url: `https://example.com/saved/${generateUuidv7()}`,
        html: "<html><body><article><h1>Saved</h1><p>A saved article body, long enough to keep.</p></article></body></html>",
      });
      w.savedIds.push(article.id);
      w.entryIds.push(article.id);
      return `save by URL ${article.id}`;
    },
  ],
  [
    1,
    async (w, rng) => {
      const live = await liveTagIds(w);
      if (rng.chance(0.5) && live.length > 0) {
        const tagId = rng.pick(live);
        await markAllEntriesRead(db, { userId: w.userId, tagId, showSpam: false });
        return `mark tag ${tagId} read`;
      }
      const sub = rng.pick(await activeSubscriptionIds(w));
      await markAllEntriesRead(db, { userId: w.userId, subscriptionId: sub, showSpam: false });
      return `mark ${sub} read`;
    },
  ],
  [
    1,
    async (w, rng) => {
      const live = await liveTagIds(w);
      if (live.length > 1 && rng.chance(0.5)) {
        const tagId = rng.pick(live);
        await deleteTag(db, w.userId, tagId);
        return `delete tag ${tagId}`;
      }
      w.tagIds.push(await createTestTag(w.userId));
      return "create tag";
    },
  ],
  [
    1,
    async (w, rng) => {
      const active = new Set(await activeSubscriptionIds(w));
      const live = w.collections.filter((c) => active.has(c));
      if (live.length > 1 && rng.chance(0.5)) {
        const id = rng.pick(live);
        const before = await membershipCount(id);
        await createCaller(await createAuthContext(w.userId)).subscriptions.delete({ id });
        // A deleted collection's memberships stay, and stop counting.
        expect(await membershipCount(id)).toBe(TODAY.deletedCollectionsEmptied ? 0 : before);
        return `delete collection ${id}`;
      }
      w.collections.push((await createCollection(db, w.userId, "New")).subscription.id);
      return "create collection";
    },
  ],
];

OPS.push(
  [
    1,
    async (w, rng) => {
      // A redirect merge onto a new feed: re-stamps the entries, moves the
      // tags, unsubscribes the old subscription and subscribes to the new one.
      // Never the shared feed: a merge moves every user's subscription to it,
      // and the other world would keep resubscribing to a redirected feed.
      const index = w.feeds.indexOf(rng.pick(ownFeeds(w)));
      const old = w.feeds[index];
      const [oldFeed] = await db.select().from(feeds).where(eq(feeds.id, old.feedId));
      const [newFeed] = await db
        .select()
        .from(feeds)
        .where(eq(feeds.id, await createTestFeed()));
      await migrateSubscriptionsToExistingFeed(oldFeed, newFeed);
      const [survivor] = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(and(eq(subscriptions.userId, w.userId), eq(subscriptions.feedId, newFeed.id)));
      if (survivor)
        replaceFeed(w, old.subscriptionId, { feedId: newFeed.id, subscriptionId: survivor.id });
      return `merge ${old.feedId} into ${newFeed.id}`;
    },
  ],
  [
    1,
    async (w, rng) => {
      // A redirect merge onto another feed the user follows (or followed):
      // the survivor already holds some articles and keeps its own tags.
      const from = w.feeds.indexOf(rng.pick(ownFeeds(w)));
      const onto = rng.pick(ownFeeds(w).filter((f) => f.feedId !== w.feeds[from].feedId));
      if (!onto) return "merge onto existing: one feed";
      const old = w.feeds[from];
      const [oldFeed] = await db.select().from(feeds).where(eq(feeds.id, old.feedId));
      const [newFeed] = await db.select().from(feeds).where(eq(feeds.id, onto.feedId));
      await migrateSubscriptionsToExistingFeed(oldFeed, newFeed);
      const merged = !(await activeSubscriptionIds(w)).includes(old.subscriptionId);
      if (merged) replaceFeed(w, old.subscriptionId, onto);
      return `merge ${old.subscriptionId} onto ${onto.subscriptionId}${merged ? "" : " (inactive)"}`;
    },
  ],
  [
    1,
    async (w, rng) => {
      // A newsletter, spam or not, while the email subscription is active.
      if (!(await activeSubscriptionIds(w)).includes(w.emailSubscriptionId)) {
        return "new email: unsubscribed";
      }
      const [{ feedId }] = await db
        .select({ feedId: subscriptions.feedId })
        .from(subscriptions)
        .where(eq(subscriptions.id, w.emailSubscriptionId));
      const isSpam = rng.chance(0.5);
      const id = await createTestEntry(feedId!, { type: "email", isSpam, userIds: [w.userId] });
      w.entryIds.push(id);
      return `new email ${id}${isSpam ? " (spam)" : ""}`;
    },
  ],
  [
    1,
    async (w, rng) => {
      // One statement flipping some rows read and others unread.
      const ids = [rng.pick(await visibleEntryIds(w)), rng.pick(await visibleEntryIds(w))];
      await db
        .update(userEntries)
        .set({ read: sql`NOT ${userEntries.read}` })
        .where(and(eq(userEntries.userId, w.userId), inArray(userEntries.entryId, ids)));
      return `flip ${ids.join(",")}`;
    },
  ]
);

OPS.push(
  [
    2,
    async () => {
      // A fetch of the shared feed: one statement fanning out to every world
      // still subscribed (createUserEntriesForFeed, as the fetch job does).
      const entryId = await createTestEntry(sharedFeedId);
      await createUserEntriesForFeed(sharedFeedId, [entryId]);
      for (const world of currentWorlds) world.entryIds.push(entryId);
      return `fan out ${entryId}`;
    },
  ],
  [
    2,
    async (w, rng) => {
      // Newsletters from a second sender, through the real ingest path:
      // delivery creates (or reactivates) the subscription, unsubscribing
      // blocks the sender, and unblocking lets the next issue resubscribe.
      const sender = `letters-${w.userId}@example.com`;
      const [sub] = await db
        .select({
          id: subscriptions.id,
          active: sql<boolean>`${subscriptions.unsubscribedAt} IS NULL`,
        })
        .from(subscriptions)
        .innerJoin(feeds, eq(feeds.id, subscriptions.feedId))
        .where(and(eq(subscriptions.userId, w.userId), eq(feeds.emailSenderPattern, sender)));
      const caller = createCaller(await createAuthContext(w.userId));
      if (sub?.active && rng.chance(0.3)) {
        await caller.subscriptions.delete({ id: sub.id });
        return `unsubscribe email ${sub.id}`;
      }
      if (sub && !sub.active) {
        const [blocked] = await db
          .select({ id: blockedSenders.id })
          .from(blockedSenders)
          .where(and(eq(blockedSenders.userId, w.userId), eq(blockedSenders.senderEmail, sender)));
        if (blocked) await caller.blockedSenders.unblock({ id: blocked.id });
      }
      const result = await processInboundEmail({
        to: `${w.ingestToken}@ingest.lionreader.com`,
        from: { address: sender, name: "Letters" },
        subject: "Issue",
        messageId: `<${generateUuidv7()}@example.com>`,
        html: "<p>Issue</p>",
        headers: {},
      });
      if (result.entryId) w.entryIds.push(result.entryId);
      return `email ${result.entryId ?? "dropped"}`;
    },
  ],
  [
    1,
    async (w, rng) => {
      // Deleting a feed (as account deletion does an orphaned one): its
      // entries, their rows and memberships, and the subscription go by
      // cascade. The world then follows a fresh feed in its place.
      const gone = rng.pick(ownFeeds(w));
      if (!gone) return "delete feed: none";
      await db.delete(feeds).where(eq(feeds.id, gone.feedId));
      const feedId = await createTestFeed();
      const fresh = { feedId, subscriptionId: await createTestSubscription(w.userId, feedId) };
      w.feeds = w.feeds.map((f) => (f.feedId === gone.feedId ? fresh : f));
      w.entryIds.push(await createTestEntry(feedId, { userIds: [w.userId] }));
      return `delete feed ${gone.feedId}`;
    },
  ]
);

function pickOp(rng: ReturnType<typeof prng>): Op {
  const weighted = OPS.flatMap(([weight, op]) => Array.from({ length: weight }, () => op));
  return rng.pick(weighted);
}

/** Every badge must match the unread count of the list it labels. */
async function expectBadgesMatchLists(userId: string): Promise<void> {
  const [user] = await db
    .select({
      all: users.allUnreadCount,
      uncategorized: users.uncategorizedUnreadCount,
    })
    .from(users)
    .where(eq(users.id, userId));
  const visibleUnread = await db.execute<{ n: number }>(
    sql`SELECT count(*)::int AS n FROM visible_entries
        WHERE user_id = ${userId} AND NOT read AND NOT is_spam`
  );
  expect(user.all, "All").toBe(visibleUnread.rows[0].n);

  const count = (filter: { tagId?: string; uncategorized?: boolean; subscriptionId?: string }) =>
    countEntries(db, userId, { ...filter, unreadOnly: true }).then((r) => r.unread);
  expect(user.uncategorized, "Uncategorized").toBe(await count({ uncategorized: true }));

  for (const tag of await db
    .select({ id: tags.id, unread: tags.unreadCount })
    .from(tags)
    .where(and(eq(tags.userId, userId), isNull(tags.deletedAt)))) {
    expect(tag.unread, `tag ${tag.id}`).toBe(await count({ tagId: tag.id }));
  }
  for (const sub of await db
    .select({ id: subscriptions.id, unread: subscriptions.unreadCount })
    .from(subscriptions)
    .where(
      and(
        eq(subscriptions.userId, userId),
        isNull(subscriptions.unsubscribedAt),
        // The saved subscription's list is Saved, below.
        sql`${subscriptions.type} <> 'saved'`
      )
    )) {
    expect(sub.unread, `subscription ${sub.id}`).toBe(await count({ subscriptionId: sub.id }));
  }

  // Starred and Saved count from counters, so count their lists' pages.
  const listed = async (filter: { starredOnly?: boolean; type?: "saved" }) =>
    (
      await listEntries(db, {
        userId,
        ...filter,
        unreadOnly: true,
        showSpam: false,
        limit: 1000,
        maxLimit: 1000,
      })
    ).items.length;
  const [globals] = await db
    .select({ starred: users.starredUnreadCount, saved: users.savedUnreadCount })
    .from(users)
    .where(eq(users.id, userId));
  expect(globals.starred, "Starred").toBe(await listed({ starredOnly: true }));
  expect(globals.saved, "Saved").toBe(await listed({ type: "saved" }));
}

describe("unread counters under random operations", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it.each(SEEDS)(
    "stay exact (seed %i)",
    async (seed) => {
      const rng = prng(seed);
      // Two users, so a counter leaking across users shows up as drift.
      sharedFeedId = await createTestFeed();
      const worlds = [
        await createWorld({ withSaved: true }),
        await createWorld({ withSaved: false }),
      ];
      currentWorlds = worlds;
      await expectBadgesMatchLists(worlds[0].userId);

      const history: string[] = [];
      for (let step = 0; step < STEPS; step++) {
        const index = rng.chance(0.5) ? 0 : 1;
        if (rng.chance(0.01)) {
          // Deleting a user (with whatever collections and members it has)
          // must leave everyone else's counters exact.
          await db.delete(users).where(eq(users.id, worlds[index].userId));
          worlds[index] = await createWorld({ withSaved: false });
          history.push(`delete user, new world ${worlds[index].userId}`);
        }
        const world = worlds[index];
        history.push(await pickOp(rng)(world, rng));
        const context = `seed ${seed}, step ${step}:\n${history.slice(-5).join("\n")}`;
        for (const w of worlds) await expectCountersMatchModel(w.userId, context);
        expect(await reconcileCounters(db), context).toEqual({
          userEntriesFixed: 0,
          subscriptionsFixed: 0,
          usersFixed: 0,
          tagsFixed: 0,
        });
        await expectBadgesMatchLists(world.userId);
        expect(await checkSubscriptionEntries(db), context).toEqual({
          missing: 0,
          extra: 0,
          misdated: 0,
        });
      }
    },
    120_000
  );
});
