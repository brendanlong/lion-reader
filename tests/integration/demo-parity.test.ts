/**
 * The demo store (`src/lib/demo/store.ts`) stands in for the server
 * in the public demo, so the client's cache code sees its outputs as if they
 * were real. These scenarios run the same calls against the demo store and
 * against the real tRPC caller seeded with the same fixtures, and compare the
 * outputs once ids are mapped back and timestamps dropped (#1936).
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/server/db";
import {
  entries,
  feeds,
  subscriptionEntries,
  subscriptions,
  subscriptionTags,
  tags,
  userEntries,
  users,
} from "../../src/server/db/schema";
import { createCaller } from "../../src/server/trpc/root";
import { createDemoStore, type DemoFixtures, type DemoProcedures } from "../../src/lib/demo/store";
import { DEMO_ENTRIES, DEMO_SUBSCRIPTIONS, DEMO_TAGS } from "../../src/lib/demo/data";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSavedSubscription,
  createTestSubscription,
  createTestTag,
  createTestUser,
} from "./helpers";

// The demo files its newsletters under web subscriptions, which the server
// can't: an email is owned by its sender's subscription.
const FIXTURES: DemoFixtures = {
  tags: DEMO_TAGS,
  subscriptions: DEMO_SUBSCRIPTIONS,
  entries: DEMO_ENTRIES.filter((entry) => entry.type !== "email"),
};

type Path = keyof DemoProcedures;
type Input<P extends Path> = Parameters<DemoProcedures[P]>[0];
type Output<P extends Path> = ReturnType<DemoProcedures[P]>;

/** One implementation of the procedures, addressed by fixture (demo) ids. */
interface Side {
  call<P extends Path>(path: P, input: Input<P>): Promise<Output<P>>;
  /** Maps this side's ids in an output back to fixture ids. */
  normalize(value: unknown): unknown;
}

/** Fields that differ by when, not what: write times and count stamps. */
const TIME_FIELDS = new Set([
  "asOf",
  "unreadCountAsOf",
  "updatedAt",
  "readChangedAt",
  "subscribedAt",
  "createdAt",
]);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replaces ids found in `ids`, names ids it doesn't know (made during the
 * scenario, like a new collection's) by first appearance, drops time fields
 * and sorts arrays, whose order the API doesn't promise, except an `order`.
 */
function normalizer(ids: Map<string, string>): (value: unknown) => unknown {
  const created = new Map<string, string>();
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") {
      const known = ids.get(value);
      if (known) return known;
      if (!UUID.test(value)) return value;
      if (!created.has(value)) created.set(value, `created-${created.size + 1}`);
      return created.get(value);
    }
    if (Array.isArray(value)) {
      const items = value.map(walk);
      return items.every(isRecordWithId)
        ? [...items].sort((a, b) => String(a.id).localeCompare(String(b.id)))
        : items.every((item) => typeof item === "string")
          ? [...items].sort()
          : items;
    }
    if (value instanceof Date || value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value)
        // Demo subscriptions have no feed URL.
        .filter(([key]) => !(key === "url" && "originalTitle" in value))
        .filter(([key, v]) => !TIME_FIELDS.has(key) && v !== undefined)
        .map(([key, v]) => [key, key === "order" && Array.isArray(v) ? v.map(walk) : walk(v)])
    );
  };
  return walk;
}

function isRecordWithId(value: unknown): value is { id: unknown } {
  return typeof value === "object" && value !== null && "id" in value;
}

/** Replaces fixture ids in an input with this side's. */
function translate(value: unknown, ids: Map<string, string>): unknown {
  if (typeof value === "string") return ids.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => translate(item, ids));
  if (value instanceof Date || value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, translate(v, ids)]));
}

function demoSide(): Side {
  const { procedures } = createDemoStore(FIXTURES);
  const call = (path: Path, input: unknown): Promise<unknown> =>
    Promise.resolve((procedures[path] as (input: unknown) => unknown)(input));
  return {
    call: call as Side["call"],
    normalize: normalizer(new Map([["demo-saved", "saved"]])),
  };
}

/** Seeds the database with the demo fixtures as one user's data. */
async function realSide(): Promise<Side> {
  const userId = await createTestUser();
  const toReal = new Map<string, string>();

  for (const sub of FIXTURES.subscriptions) {
    const feedId = await createTestFeed({ title: sub.title, description: sub.description });
    toReal.set(sub.id, await createTestSubscription(userId, feedId));
    toReal.set(`feed:${sub.id}`, feedId);
  }
  for (const tag of FIXTURES.tags) {
    const tagged = FIXTURES.subscriptions.filter((sub) => sub.tagId === tag.id);
    toReal.set(
      tag.id,
      await createTestTag(userId, {
        name: tag.name,
        color: tag.color,
        subscriptionIds: tagged.map((sub) => toReal.get(sub.id)!),
      })
    );
  }
  for (const entry of FIXTURES.entries) {
    const owner = entry.type === "saved" ? userId : toReal.get(`feed:${entry.subscriptionId}`)!;
    const publishedAt = entry.publishedAt ?? entry.fetchedAt;
    toReal.set(
      entry.id,
      await createTestEntry(owner, {
        type: entry.type,
        title: entry.title,
        url: entry.url,
        author: entry.author,
        summary: entry.summary,
        contentCleaned: entry.contentHtml,
        publishedAt,
        fetchedAt: entry.fetchedAt,
        userIds: [userId],
        starredBy: entry.starred ? [userId] : [],
      })
    );
  }
  toReal.set("demo-saved", await createTestSavedSubscription(userId));

  const caller = createCaller(await createAuthContext(userId));
  const toFixture = new Map(
    [...toReal].filter(([key]) => !key.startsWith("feed:")).map(([demo, real]) => [real, demo])
  );
  toFixture.set(toReal.get("demo-saved")!, "saved");
  const call = (path: Path, input: unknown): Promise<unknown> => {
    const [router, procedure] = path.split(".");
    const routers = caller as unknown as Record<
      string,
      Record<string, (input: unknown) => Promise<unknown>>
    >;
    return routers[router][procedure](translate(input, toReal));
  };
  return { call: call as Side["call"], normalize: normalizer(toFixture) };
}

/** Every unread count the sidebar shows. */
async function counts(side: Side): Promise<unknown> {
  const subs = await side.call("subscriptions.list", {});
  const tagList = await side.call("tags.list", undefined);
  const { all, starred, saved } = await side.call("entries.countLists", undefined);
  return {
    all,
    starred,
    saved,
    subscriptions: subs.items.map((sub) => ({
      id: sub.id,
      unreadCount: sub.unreadCount,
      tags: sub.tags.map((tag) => tag.id),
    })),
    tags: tagList.items.map((tag) => ({
      id: tag.id,
      unreadCount: tag.unreadCount,
      feedCount: tag.feedCount,
    })),
    uncategorized: tagList.uncategorized,
  };
}

/** A list's entries, and their ids in the order served. */
async function listOrder(side: Side, input: Input<"entries.list">): Promise<unknown> {
  const { items } = await side.call("entries.list", input);
  return { order: items.map((item) => item.id), items };
}

const webEntry = FIXTURES.entries.find((entry) => entry.type === "web" && !entry.starred)!;
const starredEntry = FIXTURES.entries.find((entry) => entry.type === "web" && entry.starred)!;
const savedEntry = FIXTURES.entries.find((entry) => entry.type === "saved")!;
const firstTag = DEMO_TAGS[0];
const taggedSubscription = FIXTURES.subscriptions.find(
  (sub) => sub.id === webEntry.subscriptionId
)!;

/** Each returns the outputs to compare: every call's, then the counts after. */
const SCENARIOS: Record<string, (side: Side) => Promise<unknown[]>> = {
  "mark read and unread": async (side) => [
    await side.call("entries.markRead", {
      entries: [{ id: webEntry.id }, { id: savedEntry.id }],
      read: true,
    }),
    await counts(side),
    await side.call("entries.markRead", { entries: [{ id: webEntry.id }], read: false }),
    await counts(side),
  ],
  "re-mark an already read entry": async (side) => [
    await side.call("entries.markRead", { entries: [{ id: webEntry.id }], read: true }),
    await side.call("entries.markRead", { entries: [{ id: webEntry.id }], read: true }),
  ],
  "star and unstar": async (side) => [
    await side.call("entries.setStarred", { id: webEntry.id, starred: true }),
    await counts(side),
    await side.call("entries.setStarred", { id: starredEntry.id, starred: false }),
    await counts(side),
    await listOrder(side, { starredOnly: true }),
  ],
  "mark all read in a tag": async (side) => [
    await side.call("entries.markAllRead", { tagId: firstTag.id }),
    await counts(side),
  ],
  "mark all read everywhere": async (side) => [
    await side.call("entries.markAllRead", {}),
    await counts(side),
  ],
  "untag a subscription": async (side) => [
    await side.call("subscriptions.setTags", { id: taggedSubscription.id, tagIds: [] }),
    await counts(side),
  ],
  unsubscribe: async (side) => [
    await side.call("subscriptions.delete", { id: webEntry.subscriptionId! }),
    await counts(side),
    await listOrder(side, { subscriptionId: webEntry.subscriptionId! }),
  ],
  "add to and remove from a collection": async (side) => {
    const created = await side.call("collections.create", { name: "Reading list" });
    const collectionId = created.subscription.id;
    return [
      created,
      await side.call("collections.addEntries", {
        id: collectionId,
        entryIds: [webEntry.id, savedEntry.id],
      }),
      await counts(side),
      await side.call("collections.removeEntries", { id: collectionId, entryIds: [webEntry.id] }),
      await counts(side),
    ];
  },
};

async function clean(): Promise<void> {
  await db.delete(subscriptionEntries);
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionTags);
  await db.delete(tags);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

beforeEach(clean);
afterAll(clean);

describe("demo store parity with the server", () => {
  it.each(Object.entries(SCENARIOS))("%s", async (_name, scenario) => {
    const demo = demoSide();
    const real = await realSide();
    const expected = (await scenario(real)).map(real.normalize);
    const actual = (await scenario(demo)).map(demo.normalize);
    expect(actual).toEqual(expected);
  });
});
