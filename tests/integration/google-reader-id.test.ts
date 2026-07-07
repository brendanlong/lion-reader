/**
 * Integration tests for batchInt64ToUuid — the Google Reader int64 -> UUIDv7
 * resolver used by stream/items/contents.
 *
 * A UUIDv7's int64 form is a lossy projection (48-bit timestamp + 15 random
 * bits), so resolution fetches candidate UUIDs sharing each requested timestamp
 * and disambiguates by the random bits. These tests lock in that the batched,
 * single-query resolver (which replaced a one-query-per-millisecond loop, and
 * added an index-seekable BETWEEN bound) still resolves correctly across many
 * distinct timestamps, skips unknown ids, and dedupes repeats.
 */

import { randomBytes } from "node:crypto";
import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, entries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { batchInt64ToUuid, uuidToInt64 } from "../../src/server/google-reader/id";

/** UUIDv7 with an explicit millisecond timestamp, so tests can force distinct ms. */
function uuidv7At(timestampMs: number): string {
  const bytes = randomBytes(16);
  bytes[0] = (timestampMs / 2 ** 40) & 0xff;
  bytes[1] = (timestampMs / 2 ** 32) & 0xff;
  bytes[2] = (timestampMs / 2 ** 24) & 0xff;
  bytes[3] = (timestampMs / 2 ** 16) & 0xff;
  bytes[4] = (timestampMs / 2 ** 8) & 0xff;
  bytes[5] = timestampMs & 0xff;
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

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

async function insertEntry(feedId: string, id: string): Promise<void> {
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
}

afterAll(async () => {
  if (createdEntryIds.length) {
    await db.delete(entries).where(inArray(entries.id, createdEntryIds));
  }
  if (createdFeedIds.length) {
    await db.delete(feeds).where(inArray(feeds.id, createdFeedIds));
  }
});

describe("batchInt64ToUuid", () => {
  it("resolves many ids across distinct milliseconds in one query", async () => {
    const feedId = await createFeed();
    // Distinct ms per entry — the case the old per-ms loop degenerated on.
    const base = Date.now() - 1_000_000;
    const uuids: string[] = [];
    for (let i = 0; i < 50; i++) {
      const uuid = uuidv7At(base + i * 137); // spread across distinct ms
      await insertEntry(feedId, uuid);
      uuids.push(uuid);
    }

    const int64s = uuids.map(uuidToInt64);
    const resolved = await batchInt64ToUuid(db, int64s);

    expect(resolved.size).toBe(uuids.length);
    for (let i = 0; i < uuids.length; i++) {
      expect(resolved.get(int64s[i])).toBe(uuids[i]);
    }
  });

  it("resolves multiple ids sharing one millisecond via the random bits", async () => {
    const feedId = await createFeed();
    const ts = Date.now() - 500_000;
    const uuids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const uuid = uuidv7At(ts); // same ms, different random bits
      await insertEntry(feedId, uuid);
      uuids.push(uuid);
    }

    const int64s = uuids.map(uuidToInt64);
    const resolved = await batchInt64ToUuid(db, int64s);

    expect(resolved.size).toBe(uuids.length);
    for (let i = 0; i < uuids.length; i++) {
      expect(resolved.get(int64s[i])).toBe(uuids[i]);
    }
  });

  it("skips ids with no matching entry", async () => {
    const feedId = await createFeed();
    const real = uuidv7At(Date.now() - 250_000);
    await insertEntry(feedId, real);
    const realInt64 = uuidToInt64(real);
    // A well-formed int64 for a UUID we never inserted.
    const missingInt64 = uuidToInt64(uuidv7At(Date.now() - 250_001));

    const resolved = await batchInt64ToUuid(db, [realInt64, missingInt64]);

    expect(resolved.get(realInt64)).toBe(real);
    expect(resolved.has(missingInt64)).toBe(false);
    expect(resolved.size).toBe(1);
  });

  it("dedupes repeated ids", async () => {
    const feedId = await createFeed();
    const uuid = uuidv7At(Date.now() - 100_000);
    await insertEntry(feedId, uuid);
    const int64 = uuidToInt64(uuid);

    const resolved = await batchInt64ToUuid(db, [int64, int64, int64]);

    expect(resolved.size).toBe(1);
    expect(resolved.get(int64)).toBe(uuid);
  });

  it("returns an empty map for no ids", async () => {
    const resolved = await batchInt64ToUuid(db, []);
    expect(resolved.size).toBe(0);
  });
});
