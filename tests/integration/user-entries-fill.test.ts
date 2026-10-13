/**
 * The user_entries_fill_denormalized trigger: a row inserted without its
 * denormalized copies of the entry (`is_spam`, the `published_or_fetched_at`
 * sort key) gets them from the entry, and explicit values stand.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { userEntries, users } from "../../src/server/db/schema";
import { createTestEmailSubscription, createTestEntry, createTestUser } from "./helpers";

async function getUserEntry(userId: string, entryId: string) {
  const [row] = await db
    .select({
      isSpam: userEntries.isSpam,
      publishedOrFetchedAt: userEntries.publishedOrFetchedAt,
    })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
  return row;
}

describe("user_entries fill trigger", () => {
  // Deleting the users cascades to their subscriptions, entries and rows.
  const cleanup = () => db.delete(users);
  beforeEach(cleanup);
  afterAll(cleanup);

  it("fills is_spam and the sort key from the entry when omitted", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestEmailSubscription(userId);
    // No published_at, so the sort key must come from fetched_at.
    const fetchedAt = new Date("2026-01-02T03:04:05Z");
    const entryId = await createTestEntry(subscriptionId, {
      type: "email",
      isSpam: true,
      publishedAt: null,
      fetchedAt,
    });

    await db.insert(userEntries).values({ userId, entryId });

    const row = await getUserEntry(userId, entryId);
    expect(row.isSpam).toBe(true);
    expect(row.publishedOrFetchedAt?.epochMilliseconds).toBe(fetchedAt.getTime());
  });

  it("keeps explicitly provided values", async () => {
    const userId = await createTestUser();
    const subscriptionId = await createTestEmailSubscription(userId);
    const entryId = await createTestEntry(subscriptionId, { type: "email", isSpam: false });

    await db.insert(userEntries).values({ userId, entryId, isSpam: true });

    expect((await getUserEntry(userId, entryId)).isSpam).toBe(true);
  });
});
