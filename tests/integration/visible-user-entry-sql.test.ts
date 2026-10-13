/**
 * Queries that start from `user_entries` (sync) apply `visibleUserEntrySql`
 * instead of reading the `visible_entries` view, so the two must select the
 * same entries (#1935).
 */

import { describe, it, expect, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { userEntries, users, visibleEntries } from "../../src/server/db/schema";
import { createCollection } from "../../src/server/services/collections";
import { visibleUserEntrySql } from "../../src/server/services/entry-filters";
import {
  createTestEntry,
  createTestFeed,
  createTestMembership,
  createTestSubscription,
  createTestUser,
} from "./helpers";

const createdUserIds: string[] = [];

afterAll(async () => {
  for (const userId of createdUserIds) {
    await db.delete(users).where(eq(users.id, userId));
  }
});

describe("visibleUserEntrySql", () => {
  it("selects the entries the visible_entries view shows", async () => {
    const userId = await createTestUser();
    createdUserIds.push(userId);
    const activeFeedId = await createTestFeed();
    await createTestSubscription(userId, activeFeedId);
    const goneFeedId = await createTestFeed();
    await createTestSubscription(userId, goneFeedId, { unsubscribedAt: new Date() });

    const subscribed = await createTestEntry(activeFeedId, { userIds: [userId] });
    const starredOrphan = await createTestEntry(goneFeedId, {
      userIds: [userId],
      starredBy: [userId],
    });
    const inCollection = await createTestEntry(goneFeedId, { userIds: [userId] });
    const { subscription: collection } = await createCollection(db, userId, "Reading");
    await createTestMembership(collection.id, userId, inCollection);
    await createTestEntry(goneFeedId, { userIds: [userId] });

    const byPredicate = await db
      .select({ id: userEntries.entryId })
      .from(userEntries)
      .where(and(eq(userEntries.userId, userId), visibleUserEntrySql()));
    const byView = await db
      .select({ id: visibleEntries.id })
      .from(visibleEntries)
      .where(eq(visibleEntries.userId, userId));

    const expected = [subscribed, starredOrphan, inCollection].sort();
    expect(byView.map((r) => r.id).sort()).toEqual(expected);
    expect(byPredicate.map((r) => r.id).sort()).toEqual(expected);
  });
});
