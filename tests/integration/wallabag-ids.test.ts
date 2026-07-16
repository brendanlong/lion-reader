/**
 * Integration tests for Wallabag id resolution.
 *
 * A Wallabag entry id is the entry's stored serial (`entries.greader_item_id`,
 * shared with the Google Reader API — issue #1117), replacing the old 31-bit
 * UUID hash that had real user-visible collisions. Resolution goes through
 * `visible_entries`, so a client can only address entries its user can see.
 */

import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, entries, userEntries, feeds } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { resolveWallabagEntry, entryIdToWallabagId } from "../../src/server/wallabag/id";

const createdUserIds: string[] = [];

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `wallabag-ids-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  createdUserIds.push(userId);
  return userId;
}

/** Creates a saved article for the user and returns its UUID + stored serial. */
async function createTestSavedArticle(
  userId: string
): Promise<{ entryId: string; serial: bigint }> {
  const now = new Date();
  const savedFeedId = generateUuidv7();
  await db.insert(feeds).values({
    id: savedFeedId,
    type: "saved",
    userId,
    title: "Saved Articles",
    createdAt: now,
    updatedAt: now,
  });

  const entryId = generateUuidv7();
  const url = `https://example.com/article-${entryId}`;
  const [inserted] = await db
    .insert(entries)
    .values({
      id: entryId,
      feedId: savedFeedId,
      type: "saved",
      guid: url,
      url,
      title: "Test Article",
      contentCleaned: "<article>Content</article>",
      contentHash: "test-hash",
      fetchedAt: now,
      createdAt: now,
      updatedAt: now,
    })
    .returning({ greaderItemId: entries.greaderItemId });

  await db.insert(userEntries).values({ userId, entryId });

  return { entryId, serial: inserted.greaderItemId };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Feeds (and their entries / user_entries) cascade from the user delete
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("entryIdToWallabagId", () => {
  it("returns the entry's stored serial as a number", async () => {
    const userId = await createTestUser();
    const { entryId, serial } = await createTestSavedArticle(userId);

    expect(await entryIdToWallabagId(db, userId, entryId)).toBe(Number(serial));
  });

  it("returns null for an unknown entry", async () => {
    const userId = await createTestUser();
    expect(await entryIdToWallabagId(db, userId, generateUuidv7())).toBeNull();
  });

  it("returns null for another user's entry (visibility scoping)", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const { entryId } = await createTestSavedArticle(owner);

    expect(await entryIdToWallabagId(db, other, entryId)).toBeNull();
  });
});

describe("resolveWallabagEntry", () => {
  it("resolves a numeric Wallabag id to the entry UUID + serial", async () => {
    const userId = await createTestUser();
    const { entryId, serial } = await createTestSavedArticle(userId);

    const resolved = await resolveWallabagEntry(db, userId, serial.toString());
    expect(resolved).toEqual({ id: entryId, wallabagId: Number(serial) });
  });

  it("resolves a UUID param to the same entry", async () => {
    const userId = await createTestUser();
    const { entryId, serial } = await createTestSavedArticle(userId);

    const resolved = await resolveWallabagEntry(db, userId, entryId);
    expect(resolved).toEqual({ id: entryId, wallabagId: Number(serial) });
  });

  it("does not resolve another user's entry (visibility scoping)", async () => {
    const owner = await createTestUser();
    const other = await createTestUser();
    const { entryId, serial } = await createTestSavedArticle(owner);

    expect(await resolveWallabagEntry(db, other, serial.toString())).toBeNull();
    expect(await resolveWallabagEntry(db, other, entryId)).toBeNull();
  });

  it("returns null for malformed or out-of-range params without erroring", async () => {
    const userId = await createTestUser();

    // Not a serial or UUID
    expect(await resolveWallabagEntry(db, userId, "not-an-id")).toBeNull();
    expect(await resolveWallabagEntry(db, userId, "12abc")).toBeNull();
    expect(await resolveWallabagEntry(db, userId, "")).toBeNull();
    // Beyond bigint range — must be rejected before it poisons the query
    expect(await resolveWallabagEntry(db, userId, "99999999999999999999999")).toBeNull();
    // A legacy 31-bit hash id from before the serial migration: far above any
    // stored serial, so it simply misses (client re-syncs)
    expect(await resolveWallabagEntry(db, userId, "2107373133")).toBeNull();
  });

  it("does not resolve an unknown serial", async () => {
    const userId = await createTestUser();
    const { serial } = await createTestSavedArticle(userId);

    const unknown = (serial + BigInt(1000000)).toString();
    expect(await resolveWallabagEntry(db, userId, unknown)).toBeNull();
  });
});
