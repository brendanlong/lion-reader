/**
 * Integration tests for Wallabag id resolution.
 *
 * A Wallabag entry id is the entry's stored serial (`entries.greader_item_id`,
 * shared with the Google Reader API — issue #1117), replacing the old 31-bit
 * UUID hash that had real user-visible collisions. Resolution goes through
 * `visible_entries`, so a client can only address entries its user can see.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, entries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { resolveWallabagEntry, entryIdToWallabagId } from "../../src/server/wallabag/id";
import { createTestEntry, createTestFeed, createTestUser } from "./helpers";

const createdUserIds: string[] = [];

async function createUser(): Promise<string> {
  const userId = await createTestUser({ emailPrefix: "wallabag-ids" });
  createdUserIds.push(userId);
  return userId;
}

/** Creates a saved article for the user and returns its UUID + stored serial. */
async function createTestSavedArticle(
  userId: string
): Promise<{ entryId: string; serial: bigint }> {
  const savedFeedId = await createTestFeed({ type: "saved", userId, url: null });
  const entryId = await createTestEntry(savedFeedId, { type: "saved", userIds: [userId] });
  const [entry] = await db
    .select({ greaderItemId: entries.greaderItemId })
    .from(entries)
    .where(eq(entries.id, entryId));
  return { entryId, serial: entry.greaderItemId };
}

afterAll(async () => {
  if (createdUserIds.length > 0) {
    // Feeds (and their entries / user_entries) cascade from the user delete
    await db.delete(users).where(inArray(users.id, createdUserIds));
  }
});

describe("entryIdToWallabagId", () => {
  it("returns the entry's stored serial as a number", async () => {
    const userId = await createUser();
    const { entryId, serial } = await createTestSavedArticle(userId);

    expect(await entryIdToWallabagId(db, userId, entryId)).toBe(Number(serial));
  });

  it("returns null for an unknown entry", async () => {
    const userId = await createUser();
    expect(await entryIdToWallabagId(db, userId, generateUuidv7())).toBeNull();
  });

  it("returns null for another user's entry (visibility scoping)", async () => {
    const owner = await createUser();
    const other = await createUser();
    const { entryId } = await createTestSavedArticle(owner);

    expect(await entryIdToWallabagId(db, other, entryId)).toBeNull();
  });
});

describe("resolveWallabagEntry", () => {
  it("resolves a numeric Wallabag id to the entry UUID + serial", async () => {
    const userId = await createUser();
    const { entryId, serial } = await createTestSavedArticle(userId);

    const resolved = await resolveWallabagEntry(db, userId, serial.toString());
    expect(resolved).toEqual({ id: entryId, wallabagId: Number(serial) });
  });

  it("resolves a UUID param to the same entry", async () => {
    const userId = await createUser();
    const { entryId, serial } = await createTestSavedArticle(userId);

    const resolved = await resolveWallabagEntry(db, userId, entryId);
    expect(resolved).toEqual({ id: entryId, wallabagId: Number(serial) });
  });

  it("does not resolve another user's entry (visibility scoping)", async () => {
    const owner = await createUser();
    const other = await createUser();
    const { entryId, serial } = await createTestSavedArticle(owner);

    expect(await resolveWallabagEntry(db, other, serial.toString())).toBeNull();
    expect(await resolveWallabagEntry(db, other, entryId)).toBeNull();
  });

  it("returns null for malformed or out-of-range params without erroring", async () => {
    const userId = await createUser();

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
    const userId = await createUser();
    const { serial } = await createTestSavedArticle(userId);

    const unknown = (serial + BigInt(1000000)).toString();
    expect(await resolveWallabagEntry(db, userId, unknown)).toBeNull();
  });
});
