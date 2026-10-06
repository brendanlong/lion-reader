/**
 * Deleting a user removes the web feeds only they used (#1872) and keeps feeds
 * another user still subscribes to or has entries from.
 */

import { describe, it, expect, afterAll } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds, users } from "../../src/server/db/schema";
import { deleteUser } from "../../src/server/services/users";
import { createTestEntry, createTestFeed, createTestSubscription, createTestUser } from "./helpers";

const createdUserIds: string[] = [];
const createdFeedIds: string[] = [];

afterAll(async () => {
  if (createdFeedIds.length > 0) await db.delete(feeds).where(inArray(feeds.id, createdFeedIds));
  if (createdUserIds.length > 0) await db.delete(users).where(inArray(users.id, createdUserIds));
});

async function user(): Promise<string> {
  const id = await createTestUser({ emailPrefix: "delete-user" });
  createdUserIds.push(id);
  return id;
}

async function feed(): Promise<string> {
  const id = await createTestFeed();
  createdFeedIds.push(id);
  return id;
}

async function feedExists(id: string): Promise<boolean> {
  return (await db.select({ id: feeds.id }).from(feeds).where(eq(feeds.id, id))).length > 0;
}

describe("deleteUser", () => {
  it("deletes the web feeds only the user used, with their entries, and keeps shared ones", async () => {
    const leaving = await user();
    const staying = await user();

    const onlyMine = await feed();
    await createTestSubscription(leaving, onlyMine);
    const orphanEntry = await createTestEntry(onlyMine, { userIds: [leaving] });

    const shared = await feed();
    await createTestSubscription(leaving, shared);
    await createTestSubscription(staying, shared);

    // Not subscribed by the other user, but they still have (e.g. starred) entries from it.
    const stillRead = await feed();
    await createTestSubscription(leaving, stillRead);
    await createTestEntry(stillRead, { userIds: [leaving, staying], starredBy: [staying] });

    await deleteUser(db, leaving);

    expect(await db.select().from(users).where(eq(users.id, leaving))).toEqual([]);
    expect(await feedExists(onlyMine)).toBe(false);
    expect(await db.select().from(entries).where(eq(entries.id, orphanEntry))).toEqual([]);
    expect(await feedExists(shared)).toBe(true);
    expect(await feedExists(stillRead)).toBe(true);
  });
});
