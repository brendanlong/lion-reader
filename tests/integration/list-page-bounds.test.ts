/**
 * Every page of every entry list must cost about its page size, however much
 * data the user has (#2066), in every order it sorts by (#2064). Each list is
 * planned with EXPLAIN ANALYZE over a seed whose noise (rows the list must not
 * return) is spread across the whole timeline, so a page that walks an index
 * and filters, or sorts a whole set, reads thousands of rows where a bounded
 * page reads a few dozen. Every query a page runs is held to that, including
 * the ranked sorts' two ranges and the first page's `sortable` lookups.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool } from "../../src/server/db";
import * as schema from "../../src/server/db/schema";
import { subscriptions, users } from "../../src/server/db/schema";
import { listEntries, type ListEntriesParams } from "../../src/server/services/entries";
import {
  addEntriesToCollection,
  createCollection,
  setCollectionPositions,
} from "../../src/server/services/collections";
import { MAX_COLLECTION_BATCH } from "../../src/lib/collections";
import {
  createTestEmailSubscription,
  createTestEntryBatch,
  createTestFeed,
  createTestSubscription,
  createTestTag,
  createTestUser,
  createTestUserEntries,
} from "./helpers";

const LIMIT = 20;
/** Rows of each noise set: far more than any bounded page reads. */
const NOISE = 2000;
/** Rows of each sparse list, placed in the middle of the timeline. */
const SPARSE = 30;
/** How deep the second page tested starts. */
const DEEP = 500;
/**
 * The most rows a page may read across the big tables: the page itself, each
 * row's entry and memberships, and some slack. A walk reads thousands.
 */
const ROW_BUDGET = 8 * (LIMIT + 1);
const BIG_TABLES = new Set(["user_entries", "subscription_entries", "tag_entries", "entries"]);

const STEP_MS = 60_000;
const START = new Date("2024-01-01T00:00:00Z");
const MIDDLE = new Date(START.getTime() + (NOISE / 2) * STEP_MS);

type ListName =
  | "all"
  | "starred"
  | "subscription"
  | "tag"
  | "denseTag"
  | "uncategorized"
  | "recentlyRead"
  | "collection";
type Filter = "all" | "unread";

let userId: string;
let otherUserId: string;
const scopes: Record<ListName, Partial<ListEntriesParams>> = {
  all: {},
  starred: { starredOnly: true },
  subscription: {},
  tag: {},
  denseTag: {},
  uncategorized: { uncategorized: true },
  recentlyRead: { sortBy: "readChanged" },
  collection: {},
};
/**
 * Each feed's newest three quarters have a score (and the big feed's a
 * position in the collection), so a page of the rows without one that walks
 * the date index instead reads past all of those first.
 */
const ranked = (i: number, count: number) => i >= count / 4;
/** Few distinct values, so most rows tie and order by date within them. */
const rankValue = (i: number) => i % 5;
/** The cases whose lists are long enough for a page `DEEP` rows in. */
const LONG: ReadonlySet<`${ListName}/${Filter}`> = new Set([
  "all/all",
  "all/unread",
  "starred/all",
  "subscription/all",
  "denseTag/all",
  "denseTag/unread",
  "recentlyRead/all",
  "collection/all",
]);
const createdFeeds: string[] = [];
const positionedIds = new Set<string>();

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  "Plan Rows": number;
  "Actual Rows": number;
  "Actual Loops": number;
  "Rows Removed by Filter"?: number;
  "Rows Removed by Index Recheck"?: number;
  Plans?: PlanNode[];
}

/** Rows the plan read from the big tables, counting those it discarded. */
function bigTableRowsRead(node: PlanNode): number {
  const own =
    node["Relation Name"] && BIG_TABLES.has(node["Relation Name"])
      ? (node["Actual Rows"] +
          (node["Rows Removed by Filter"] ?? 0) +
          (node["Rows Removed by Index Recheck"] ?? 0)) *
        node["Actual Loops"]
      : 0;
  return own + (node.Plans ?? []).reduce((sum, child) => sum + bigTableRowsRead(child), 0);
}

/** One line per plan node, to show where a page that read too much spent it. */
function describePlan(node: PlanNode, depth = 0): string {
  const line = [
    "  ".repeat(depth) + node["Node Type"],
    node["Index Name"] ?? node["Relation Name"],
    `rows=${node["Actual Rows"]}`,
    `estimate=${node["Plan Rows"]}`,
    node["Rows Removed by Filter"] ? `removed=${node["Rows Removed by Filter"]}` : undefined,
    `loops=${node["Actual Loops"]}`,
  ]
    .filter(Boolean)
    .join(" ");
  return [line, ...(node.Plans ?? []).map((child) => describePlan(child, depth + 1))].join("\n");
}

/** Runs `listEntries` and returns its page with the plans of its list queries. */
async function explainPage(params: ListEntriesParams) {
  const queries: { query: string; params: unknown[] }[] = [];
  const recording = drizzle(pool, {
    schema,
    logger: { logQuery: (query, queryParams) => queries.push({ query, params: queryParams }) },
  });
  const page = await listEntries(recording, params);
  const lists = queries.filter((q) => q.query.includes('"visible_entries"'));
  if (lists.length === 0) throw new Error("listEntries ran no list query");
  const plans: PlanNode[] = [];
  for (const list of lists) {
    const result = await pool.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
      `EXPLAIN (ANALYZE, FORMAT JSON) ${list.query}`,
      list.params
    );
    plans.push(result.rows[0]["QUERY PLAN"][0].Plan);
  }
  return { page, plans };
}

/** Explains the page after `cursor` and holds each of its queries to the budget. */
async function expectBoundedPage(params: ListEntriesParams, cursor?: string) {
  const { page, plans } = await explainPage({ ...params, cursor });
  for (const plan of plans) {
    expect(bigTableRowsRead(plan), describePlan(plan)).toBeLessThanOrEqual(ROW_BUDGET);
  }
  return page;
}

/** The cursor after the list's first `rows` rows. */
async function cursorAfter(params: ListEntriesParams, rows: number): Promise<string | undefined> {
  return (await listEntries(db, { ...params, limit: rows, maxLimit: rows })).nextCursor;
}

/** A cursor `DEEP` rows into the list, or undefined if it's shorter. */
async function deepCursor(params: ListEntriesParams): Promise<string | undefined> {
  let cursor: string | undefined;
  for (let read = 0; read < DEEP; read += 100) {
    const page = await listEntries(db, { ...params, limit: 100, cursor });
    if (!page.nextCursor) return undefined;
    cursor = page.nextCursor;
  }
  return cursor;
}

/** Inserts `count` entries for the user in `subscriptionId`, from `start`. */
async function seedSubscription(
  owner: string,
  count: number,
  start: Date,
  stepMs: number,
  rows: (i: number) => { read?: boolean; starred?: boolean; readChangedAt?: Date | null },
  options: { type?: "web" | "email"; isSpam?: boolean } = {}
): Promise<string[]> {
  const ids = await createTestEntryBatch(owner, count, { start, stepMs, ...options });
  await createTestUserEntries(
    ids.map((entryId, i) => {
      const { read = false, starred = false, readChangedAt = null } = rows(i);
      const score = ranked(i, count) ? rankValue(i) : null;
      return { userId, entryId, read, starred, readChangedAt, score };
    })
  );
  return ids;
}

beforeAll(async () => {
  userId = await createTestUser({ emailPrefix: "list-bounds" });
  const feed = async () => {
    const id = await createTestFeed();
    createdFeeds.push(id);
    return id;
  };
  const halfStep = new Date(START.getTime() + STEP_MS / 2);
  const sparseStep = STEP_MS / (SPARSE + 1);

  // A big tagged feed, read except a few unread (some starred) in the middle,
  // with its newer half starred: the noise for unread, starred+unread and
  // per-subscription lists.
  const bigFeed = await feed();
  const bigSubscription = await createTestSubscription(userId, bigFeed);
  const middleUnread = (i: number) => Math.abs(i - NOISE / 2) < 3;
  const bigIds = await seedSubscription(bigFeed, NOISE, START, STEP_MS, (i) => ({
    read: !middleUnread(i),
    starred: i >= NOISE / 2 || middleUnread(i),
    readChangedAt: middleUnread(i) ? null : new Date(START.getTime() + i * STEP_MS),
  }));
  // An unread feed under the same tag: the noise for unread lists of other
  // tags and Uncategorized.
  const unreadFeed = await feed();
  const unreadSubscription = await createTestSubscription(userId, unreadFeed);
  await seedSubscription(unreadFeed, NOISE, halfStep, STEP_MS, () => ({}));
  // A collection of the big feed's articles, most of them positioned.
  // Tagged like the feed, so Uncategorized stays sparse.
  const { subscription: collection } = await createCollection(db, userId, "Book");
  for (let i = 0; i < bigIds.length; i += MAX_COLLECTION_BATCH) {
    await addEntriesToCollection(
      db,
      userId,
      collection.id,
      bigIds.slice(i, i + MAX_COLLECTION_BATCH)
    );
  }
  for (const [i, id] of bigIds.entries()) if (ranked(i, NOISE)) positionedIds.add(id);
  await setCollectionPositions(
    db,
    userId,
    collection.id,
    bigIds.flatMap((entryId, i) => (ranked(i, NOISE) ? [{ entryId, position: rankValue(i) }] : []))
  );
  const denseTag = await createTestTag(userId, {
    subscriptionIds: [bigSubscription, unreadSubscription, collection.id],
  });

  // A feed the user left, interleaved with the big one: invisible rows, half
  // unread and half read just now (Recently Read's noise).
  const goneFeed = await feed();
  const goneSubscription = await createTestSubscription(userId, goneFeed);
  await seedSubscription(goneFeed, NOISE, halfStep, STEP_MS, (i) => ({
    read: i % 2 === 0,
    readChangedAt: i % 2 === 0 ? new Date() : null,
  }));
  await db
    .update(subscriptions)
    .set({ unsubscribedAt: new Date() })
    .where(eq(subscriptions.id, goneSubscription));

  // Unread spam, hidden from lists by default.
  const spamSender = await createTestEmailSubscription(userId);
  await seedSubscription(spamSender, NOISE, halfStep, STEP_MS, () => ({}), {
    type: "email",
    isSpam: true,
  });

  // A sparse tag and a sparse Uncategorized, both in the middle.
  const sparseFeed = await feed();
  const sparseSubscription = await createTestSubscription(userId, sparseFeed);
  await seedSubscription(sparseFeed, SPARSE, MIDDLE, sparseStep, (i) => ({ read: i % 2 === 0 }));
  const sparseTag = await createTestTag(userId, { subscriptionIds: [sparseSubscription] });
  const untaggedFeed = await feed();
  await createTestSubscription(userId, untaggedFeed);
  await seedSubscription(untaggedFeed, SPARSE, MIDDLE, sparseStep, (i) => ({
    read: i % 2 === 0,
  }));

  // Another user's long, read history, so the tables' statistics are mostly
  // read, as production's are: the planner estimates filters per table, not
  // per list.
  otherUserId = await createTestUser({ emailPrefix: "list-bounds-other" });
  const otherFeed = await feed();
  await createTestSubscription(otherUserId, otherFeed);
  const otherIds = await createTestEntryBatch(otherFeed, 4 * NOISE, { start: START, stepMs: 1000 });
  await createTestUserEntries(
    otherIds.map((entryId) => ({ userId: otherUserId, entryId, read: true }))
  );

  scopes.subscription = { subscriptionId: bigSubscription };
  scopes.tag = { tagId: sparseTag };
  scopes.denseTag = { tagId: denseTag };
  scopes.collection = { subscriptionId: collection.id };
  // As autovacuum leaves a table: no dead index entries, a current visibility map.
  await db.execute(sql`VACUUM ANALYZE user_entries`);
  await db.execute(sql`VACUUM ANALYZE subscription_entries`);
  await db.execute(sql`VACUUM ANALYZE entries`);
  await db.execute(sql`VACUUM ANALYZE tag_entries`);
}, 120_000);

afterAll(async () => {
  await db.delete(users).where(inArray(users.id, [userId, otherUserId]));
  for (const feedId of createdFeeds) {
    await db.delete(schema.feeds).where(eq(schema.feeds.id, feedId));
  }
});

const DATE_CASES = (Object.keys(scopes) as ListName[]).flatMap((list) =>
  (list === "recentlyRead" ? (["all"] as const) : (["all", "unread"] as const)).flatMap((filter) =>
    (["newest", "oldest"] as const).map((sortOrder) => ({ list, filter, sortOrder }))
  )
);

const RANKED_CASES = (Object.keys(scopes) as ListName[])
  .filter((list) => list !== "recentlyRead")
  .flatMap((list) =>
    (list === "collection"
      ? [
          { sortBy: "score", sortOrder: "highest" },
          { sortBy: "score", sortOrder: "lowest" },
          { sortBy: "position", sortOrder: "first" },
          { sortBy: "position", sortOrder: "last" },
        ]
      : [
          { sortBy: "score", sortOrder: "highest" },
          { sortBy: "score", sortOrder: "lowest" },
        ]
    ).flatMap((sort) =>
      (["all", "unread"] as const).map((filter) => ({
        list,
        filter,
        ...(sort as Pick<ListEntriesParams, "sortBy" | "sortOrder">),
      }))
    )
  );

describe("entry list pages read a bounded number of rows", () => {
  for (const { list, filter, sortOrder } of DATE_CASES) {
    it(`${list}, ${filter}, ${sortOrder}`, async () => {
      const params: ListEntriesParams = {
        userId,
        ...scopes[list],
        unreadOnly: filter === "unread",
        sortOrder,
        limit: LIMIT,
        showSpam: false,
      };
      const first = await expectBoundedPage(params);
      expect(first.items.length).toBeGreaterThan(0);

      if (LONG.has(`${list}/${filter}`)) {
        const cursor = await deepCursor(params);
        expect(cursor).toBeDefined();
        await expectBoundedPage(params, cursor);
      }
    });
  }

  // A ranked page reads the rows with a value, then those without: the first
  // page, one deep in each range, and the one that changes over.
  for (const { list, filter, sortBy, sortOrder } of RANKED_CASES) {
    it(`${list}, ${filter}, ${sortBy} ${sortOrder}`, async () => {
      const params: ListEntriesParams = {
        userId,
        ...scopes[list],
        unreadOnly: filter === "unread",
        sortBy,
        sortOrder,
        limit: LIMIT,
        showSpam: false,
      };
      const whole = (await listEntries(db, { ...params, limit: 10_000, maxLimit: 10_000 })).items;
      const hasValue = (item: (typeof whole)[number]) =>
        sortBy === "score" ? item.score !== null : positionedIds.has(item.id);
      const valued = whole.filter(hasValue).length;
      const unvalued = whole.length - valued;
      expect(whole.slice(valued).some(hasValue)).toBe(false);

      const starts = [0];
      if (valued > 2 * LIMIT) starts.push(Math.min(DEEP, valued - 2 * LIMIT));
      if (valued >= LIMIT / 2 && unvalued > 0) starts.push(valued - LIMIT / 2);
      if (unvalued > LIMIT) starts.push(valued + Math.min(DEEP, unvalued - LIMIT));
      for (const start of starts) {
        const cursor = start === 0 ? undefined : await cursorAfter(params, start);
        const page = await expectBoundedPage(params, cursor);
        expect(
          page.items.map((item) => item.id),
          `from row ${start}`
        ).toEqual(whole.slice(start, start + LIMIT).map((item) => item.id));
      }
    });
  }
});
