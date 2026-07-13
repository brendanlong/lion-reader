/**
 * Integration tests for greaderItemIdsToUuids — the Google Reader item-id ->
 * UUIDv7 resolver used by stream/items/contents and edit-tag.
 *
 * Item ids are now a stored global serial (`entries.greader_item_id`), assigned
 * by a sequence default at insert time. Resolution is a single
 * `greader_item_id = ANY(ids)` seek on the unique index — no timestamp math, no
 * candidate disambiguation. These tests insert entries, read back the serials
 * the DB assigned, and lock in that the resolver round-trips them, skips unknown
 * ids, dedupes repeats, and returns an empty map for no input.
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, entries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { greaderItemIdsToUuids } from "../../src/server/google-reader/id";

const createdFeedIds: string[] = [];
const createdEntryIds: string[] = [];

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

/** Inserts an entry (letting the DB assign greader_item_id) and returns the id + assigned serial. */
async function insertEntry(feedId: string): Promise<{ id: string; greaderItemId: bigint }> {
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
});

describe("greaderItemIdsToUuids", () => {
  it("round-trips many stored item ids in one query", async () => {
    const feedId = await createFeed();
    const inserted: Array<{ id: string; greaderItemId: bigint }> = [];
    for (let i = 0; i < 50; i++) {
      inserted.push(await insertEntry(feedId));
    }

    const ids = inserted.map((e) => e.greaderItemId);
    const resolved = await greaderItemIdsToUuids(db, ids);

    expect(resolved.size).toBe(inserted.length);
    for (const entry of inserted) {
      expect(resolved.get(entry.greaderItemId)).toBe(entry.id);
    }
  });

  it("assigns a distinct greader_item_id per entry", async () => {
    const feedId = await createFeed();
    const a = await insertEntry(feedId);
    const b = await insertEntry(feedId);
    expect(a.greaderItemId).not.toBe(b.greaderItemId);

    const resolved = await greaderItemIdsToUuids(db, [a.greaderItemId, b.greaderItemId]);
    expect(resolved.get(a.greaderItemId)).toBe(a.id);
    expect(resolved.get(b.greaderItemId)).toBe(b.id);
  });

  it("skips ids with no matching entry", async () => {
    const feedId = await createFeed();
    const real = await insertEntry(feedId);
    // A serial well beyond anything the sequence has handed out.
    const missingId = real.greaderItemId + BigInt(1_000_000_000);

    const resolved = await greaderItemIdsToUuids(db, [real.greaderItemId, missingId]);

    expect(resolved.get(real.greaderItemId)).toBe(real.id);
    expect(resolved.has(missingId)).toBe(false);
    expect(resolved.size).toBe(1);
  });

  it("dedupes repeated ids", async () => {
    const feedId = await createFeed();
    const entry = await insertEntry(feedId);

    const resolved = await greaderItemIdsToUuids(db, [
      entry.greaderItemId,
      entry.greaderItemId,
      entry.greaderItemId,
    ]);

    expect(resolved.size).toBe(1);
    expect(resolved.get(entry.greaderItemId)).toBe(entry.id);
  });

  it("returns an empty map for no ids", async () => {
    const resolved = await greaderItemIdsToUuids(db, []);
    expect(resolved.size).toBe(0);
  });
});
