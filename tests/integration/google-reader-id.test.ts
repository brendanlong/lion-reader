/**
 * Integration tests for greaderItemIdsToUuids — the Google Reader item-id ->
 * UUIDv7 resolver used by stream/items/contents and edit-tag.
 *
 * Item ids are now a stored global serial (`entries.greader_item_id`), assigned
 * by a sequence default at insert time. Resolution is a single
 * `greader_item_id = ANY(ids)` seek, run through `visible_entries` so it is
 * scoped to the requesting user — no timestamp math, no candidate
 * disambiguation. These tests insert entries (with a `user_entries` row so they
 * are visible), read back the serials the DB assigned, and lock in that the
 * resolver round-trips them, skips unknown ids, dedupes repeats, refuses another
 * user's entries, and returns an empty map for no input.
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray, eq, and } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, entries, users, userEntries, subscriptions } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { greaderItemIdsToUuids } from "../../src/server/google-reader/id";

const createdUserIds: string[] = [];
const createdFeedIds: string[] = [];
const createdEntryIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `greader-id-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
}

async function createFeed(): Promise<string> {
  const feedId = generateUuidv7();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url: `https://example.com/greader-id/${feedId}/feed.xml`,
    title: "GReader ID Test Feed",
  });
  createdFeedIds.push(feedId);
  return feedId;
}

/**
 * Inserts an entry (letting the DB assign greader_item_id) and makes it visible
 * to `userId` via an active subscription + `user_entries` row. Returns the id +
 * assigned serial.
 */
async function insertEntry(
  feedId: string,
  userId: string
): Promise<{ id: string; greaderItemId: bigint }> {
  const id = generateUuidv7();
  const when = new Date();
  await db.insert(entries).values({
    id,
    feedId,
    type: "web",
    guid: `greader-id-${id}`,
    title: `Entry ${id}`,
    contentHash: `hash-${id}`,
    fetchedAt: when,
    publishedAt: when,
    lastSeenAt: when,
  });
  createdEntryIds.push(id);

  await db
    .insert(subscriptions)
    .values({ id: generateUuidv7(), userId, feedId })
    .onConflictDoNothing();
  const [sub] = await db
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, userId), eq(subscriptions.feedId, feedId)));
  await db
    .insert(userEntries)
    .values({ userId, entryId: id, subscriptionId: sub.id })
    .onConflictDoNothing();

  const [row] = await db
    .select({ greaderItemId: entries.greaderItemId })
    .from(entries)
    .where(eq(entries.id, id));
  return { id, greaderItemId: row.greaderItemId };
}

afterAll(async () => {
  if (createdEntryIds.length) {
    await db.delete(entries).where(inArray(entries.id, createdEntryIds));
  }
  if (createdFeedIds.length) {
    await db.delete(feeds).where(inArray(feeds.id, createdFeedIds));
  }
  if (createdUserIds.length) {
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("greaderItemIdsToUuids", () => {
  it("round-trips many stored item ids in one query", async () => {
    const userId = await createUser();
    const feedId = await createFeed();
    const inserted: Array<{ id: string; greaderItemId: bigint }> = [];
    for (let i = 0; i < 50; i++) {
      inserted.push(await insertEntry(feedId, userId));
    }

    const ids = inserted.map((e) => e.greaderItemId);
    const resolved = await greaderItemIdsToUuids(db, userId, ids);

    expect(resolved.size).toBe(inserted.length);
    for (const entry of inserted) {
      expect(resolved.get(entry.greaderItemId)).toBe(entry.id);
    }
  });

  it("assigns a distinct greader_item_id per entry", async () => {
    const userId = await createUser();
    const feedId = await createFeed();
    const a = await insertEntry(feedId, userId);
    const b = await insertEntry(feedId, userId);
    expect(a.greaderItemId).not.toBe(b.greaderItemId);

    const resolved = await greaderItemIdsToUuids(db, userId, [a.greaderItemId, b.greaderItemId]);
    expect(resolved.get(a.greaderItemId)).toBe(a.id);
    expect(resolved.get(b.greaderItemId)).toBe(b.id);
  });

  it("skips ids with no matching entry", async () => {
    const userId = await createUser();
    const feedId = await createFeed();
    const real = await insertEntry(feedId, userId);
    // A serial well beyond anything the sequence has handed out.
    const missingId = real.greaderItemId + BigInt(1_000_000_000);

    const resolved = await greaderItemIdsToUuids(db, userId, [real.greaderItemId, missingId]);

    expect(resolved.get(real.greaderItemId)).toBe(real.id);
    expect(resolved.has(missingId)).toBe(false);
    expect(resolved.size).toBe(1);
  });

  it("does not resolve an item id another user owns (visibility scoping)", async () => {
    const owner = await createUser();
    const other = await createUser();
    const feedId = await createFeed();
    const entry = await insertEntry(feedId, owner);

    // Owner can resolve it; a different user gets nothing for the same serial.
    const ownerResolved = await greaderItemIdsToUuids(db, owner, [entry.greaderItemId]);
    expect(ownerResolved.get(entry.greaderItemId)).toBe(entry.id);
    const otherResolved = await greaderItemIdsToUuids(db, other, [entry.greaderItemId]);
    expect(otherResolved.size).toBe(0);
  });

  it("dedupes repeated ids", async () => {
    const userId = await createUser();
    const feedId = await createFeed();
    const entry = await insertEntry(feedId, userId);

    const resolved = await greaderItemIdsToUuids(db, userId, [
      entry.greaderItemId,
      entry.greaderItemId,
      entry.greaderItemId,
    ]);

    expect(resolved.size).toBe(1);
    expect(resolved.get(entry.greaderItemId)).toBe(entry.id);
  });

  it("returns an empty map for no ids", async () => {
    const userId = await createUser();
    const resolved = await greaderItemIdsToUuids(db, userId, []);
    expect(resolved.size).toBe(0);
  });

  it("skips ids outside the bigint range without poisoning the batch", async () => {
    // parseItemId accepts unbounded hex/decimal input (e.g. 16 hex f's =
    // 2^64-1). A parameter beyond Postgres's bigint range would make Postgres
    // reject the whole query, so such ids must be skipped — and valid ids in
    // the same batch still resolve.
    const userId = await createUser();
    const feedId = await createFeed();
    const real = await insertEntry(feedId, userId);

    const unsigned64Max = BigInt(2) ** BigInt(64) - BigInt(1); // "ffffffffffffffff"
    const belowInt64Min = -(BigInt(2) ** BigInt(63)) - BigInt(1);

    const resolved = await greaderItemIdsToUuids(db, userId, [
      unsigned64Max,
      real.greaderItemId,
      belowInt64Min,
    ]);

    expect(resolved.get(real.greaderItemId)).toBe(real.id);
    expect(resolved.has(unsigned64Max)).toBe(false);
    expect(resolved.has(belowInt64Min)).toBe(false);
    expect(resolved.size).toBe(1);
  });

  it("returns an empty map when every id is out of range", async () => {
    const userId = await createUser();
    const resolved = await greaderItemIdsToUuids(db, userId, [BigInt(2) ** BigInt(64)]);
    expect(resolved.size).toBe(0);
  });
});
