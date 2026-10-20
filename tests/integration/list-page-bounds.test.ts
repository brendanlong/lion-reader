/**
 * Every page of every entry list must cost about its page size, however much
 * data the user has (#2066). Each list is planned with EXPLAIN ANALYZE over a
 * seed whose noise (rows the list must not return) is spread across the whole
 * timeline, so a page that walks an index and filters, or sorts a whole set,
 * reads thousands of rows where a bounded page reads a few dozen.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { db, pool } from "../../src/server/db";
import * as schema from "../../src/server/db/schema";
import { subscriptions, users } from "../../src/server/db/schema";
import { listEntries, type ListEntriesParams } from "../../src/server/services/entries";
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
  "all" | "starred" | "subscription" | "tag" | "denseTag" | "uncategorized" | "recentlyRead";
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
};
/** The cases whose lists are long enough for a page `DEEP` rows in. */
const LONG: ReadonlySet<`${ListName}/${Filter}`> = new Set([
  "all/all",
  "all/unread",
  "starred/all",
  "subscription/all",
  "denseTag/all",
  "denseTag/unread",
  "recentlyRead/all",
]);
const createdFeeds: string[] = [];

interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
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
    node["Rows Removed by Filter"] ? `removed=${node["Rows Removed by Filter"]}` : undefined,
    `loops=${node["Actual Loops"]}`,
  ]
    .filter(Boolean)
    .join(" ");
  return [line, ...(node.Plans ?? []).map((child) => describePlan(child, depth + 1))].join("\n");
}

/** Runs `listEntries` and returns its page with the plan of its list query. */
async function explainPage(params: ListEntriesParams) {
  const queries: { query: string; params: unknown[] }[] = [];
  const recording = drizzle(pool, {
    schema,
    logger: { logQuery: (query, queryParams) => queries.push({ query, params: queryParams }) },
  });
  const page = await listEntries(recording, params);
  const list = queries.findLast((q) => q.query.includes('"visible_entries"'));
  if (!list) throw new Error("listEntries ran no list query");
  const result = await pool.query<{ "QUERY PLAN": [{ Plan: PlanNode }] }>(
    `EXPLAIN (ANALYZE, FORMAT JSON) ${list.query}`,
    list.params
  );
  return { page, plan: result.rows[0]["QUERY PLAN"][0].Plan };
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
): Promise<void> {
  const ids = await createTestEntryBatch(owner, count, { start, stepMs, ...options });
  await createTestUserEntries(
    ids.map((entryId, i) => {
      const { read = false, starred = false, readChangedAt = null } = rows(i);
      return { userId, entryId, read, starred, readChangedAt };
    })
  );
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
  await seedSubscription(bigFeed, NOISE, START, STEP_MS, (i) => ({
    read: !middleUnread(i),
    starred: i >= NOISE / 2 || middleUnread(i),
    readChangedAt: middleUnread(i) ? null : new Date(START.getTime() + i * STEP_MS),
  }));
  // An unread feed under the same tag: the noise for unread lists of other
  // tags and Uncategorized.
  const unreadFeed = await feed();
  const unreadSubscription = await createTestSubscription(userId, unreadFeed);
  await seedSubscription(unreadFeed, NOISE, halfStep, STEP_MS, () => ({}));
  const denseTag = await createTestTag(userId, {
    subscriptionIds: [bigSubscription, unreadSubscription],
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

const CASES = (Object.keys(scopes) as ListName[]).flatMap((list) =>
  (list === "recentlyRead" ? (["all"] as const) : (["all", "unread"] as const)).flatMap((filter) =>
    (["newest", "oldest"] as const).map((sortOrder) => ({
      list,
      filter,
      sortOrder,
    }))
  )
);

describe("entry list pages read a bounded number of rows", () => {
  for (const { list, filter, sortOrder } of CASES) {
    it(`${list}, ${filter}, ${sortOrder}`, async () => {
      const params: ListEntriesParams = {
        userId,
        ...scopes[list],
        unreadOnly: filter === "unread",
        sortOrder,
        limit: LIMIT,
        showSpam: false,
      };
      const first = await explainPage(params);
      expect(first.page.items.length).toBeGreaterThan(0);
      expect(bigTableRowsRead(first.plan), describePlan(first.plan)).toBeLessThanOrEqual(
        ROW_BUDGET
      );

      if (LONG.has(`${list}/${filter}`)) {
        const cursor = await deepCursor(params);
        expect(cursor).toBeDefined();
        const deep = await explainPage({ ...params, cursor });
        expect(bigTableRowsRead(deep.plan), describePlan(deep.plan)).toBeLessThanOrEqual(
          ROW_BUDGET
        );
      }
    });
  }
});
