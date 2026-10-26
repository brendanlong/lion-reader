/**
 * Integration tests for entries.get sanitizing entry HTML per read.
 *
 * As of issue #1282 sanitization is no longer persisted: entries store only the
 * raw content columns, and the read path (entries.get, and the services-layer
 * getEntry/getEntries used by MCP/Google Reader/Wallabag) sanitizes on every
 * read. These tests verify raw feed HTML never reaches a consumer, against a
 * real database.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import * as entryReadsService from "../../src/server/services/entry-reads";
import {
  createAuthContext,
  createTestEntry,
  createTestFeed,
  createTestSubscription,
  createTestUser,
} from "./helpers";

async function seedSubscribedUser(
  subscriptionOverrides: { fetchFullContent?: boolean } = {}
): Promise<{ userId: string; feedId: string }> {
  const now = new Date();
  const userId = await createTestUser();
  const feedId = await createTestFeed({
    title: "Test Feed",
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
  });
  await createTestSubscription(userId, feedId, subscriptionOverrides);
  return { userId, feedId };
}

describe("entries.get sanitized content", () => {
  async function cleanup(): Promise<void> {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  }

  beforeEach(cleanup);
  afterAll(cleanup);

  it("sanitizes the raw content on read, never returning raw HTML", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = await createTestEntry(feedId, {
      title: "Unsafe",
      contentCleaned: '<p onclick="evil()">hello<script>alert(1)</script></p>',
      userIds: [userId],
    });

    const caller = createCaller(await createAuthContext(userId));
    const { entry } = await caller.entries.get({ id: entryId });

    expect(entry.contentCleaned).toContain("hello");
    expect(entry.contentCleaned).not.toContain("<script>");
    expect(entry.contentCleaned).not.toContain("onclick");
  });

  it("returns null full-content fields when the entry has no full content", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = await createTestEntry(feedId, {
      title: "No full content",
      contentCleaned: "<p>hello</p>",
      fullContentCleaned: null,
      userIds: [userId],
    });

    const caller = createCaller(await createAuthContext(userId));
    const { entry } = await caller.entries.get({ id: entryId });
    expect(entry.contentCleaned).toContain("hello");
    expect(entry.fullContentOriginal).toBeNull();
    expect(entry.fullContentCleaned).toBeNull();
  });

  it("serves full content sanitized", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = await createTestEntry(feedId, {
      title: "Full content",
      contentCleaned: "<p>feed body</p>",
      fullContentCleaned: '<p onclick="evil()">full cleaned<script>alert(2)</script></p>',
      fullContentHash: "fullhash",
      fullContentFetchedAt: new Date(),
      userIds: [userId],
    });

    const caller = createCaller(await createAuthContext(userId));
    const { entry } = await caller.entries.get({ id: entryId });

    expect(entry.fullContentCleaned).toContain("full cleaned");
    expect(entry.fullContentCleaned).not.toContain("<script>");
    expect(entry.fullContentCleaned).not.toContain("onclick");
  });

  // The services-layer getEntry/getEntries are the read path for MCP get_entry,
  // Google Reader, and Wallabag — they must sanitize content too, not just the
  // tRPC router (issue #956).
  describe("services getEntry/getEntries", () => {
    it("getEntry sanitizes the raw content, never returning raw HTML", async () => {
      const { userId, feedId } = await seedSubscribedUser();
      const entryId = await createTestEntry(feedId, {
        title: "Unsafe",
        contentCleaned: '<p onclick="evil()">hello<script>alert(1)</script></p>',
        userIds: [userId],
      });

      const entry = await entryReadsService.getEntry(db, userId, entryId);
      expect(entry.contentCleaned).toContain("hello");
      expect(entry.contentCleaned).not.toContain("<script>");
      expect(entry.contentCleaned).not.toContain("onclick");
    });

    it("getEntries sanitizes every returned entry", async () => {
      const { userId, feedId } = await seedSubscribedUser();
      const entryIds = [generateUuidv7(), generateUuidv7()];
      for (const entryId of entryIds) {
        await createTestEntry(feedId, {
          id: entryId,
          title: "Bulk",
          contentCleaned: `<p>body-${entryId}<script>alert(1)</script></p>`,
          userIds: [userId],
        });
      }

      const results = await entryReadsService.getEntries(db, userId, entryIds);
      expect(results).toHaveLength(2);
      for (const [i, entry] of results.entries()) {
        expect(entry.id).toBe(entryIds[i]);
        expect(entry.contentCleaned).toContain(`body-${entryIds[i]}`);
        expect(entry.contentCleaned).not.toContain("<script>");
      }
    });

    // Issue #1787: Google Reader/Wallabag clients got the feed teaser even when
    // the subscription fetches full articles. Two subscribers to one feed, so a
    // join on anything but the reader's own subscription would leak the setting.
    it("serves sanitized full content only to subscribers who show it", async () => {
      const { userId: enabledUserId, feedId } = await seedSubscribedUser({
        fetchFullContent: true,
      });
      const disabledUserId = await createTestUser();
      await createTestSubscription(disabledUserId, feedId, { fetchFullContent: false });
      const entryId = await createTestEntry(feedId, {
        contentCleaned: "<p>teaser</p>",
        fullContentCleaned: '<p onclick="evil()">full article<script>alert(1)</script></p>',
        fullContentHash: "fullhash",
        fullContentFetchedAt: new Date(),
        userIds: [enabledUserId, disabledUserId],
      });

      const [entry] = await entryReadsService.getEntries(db, enabledUserId, [entryId]);
      expect(entry.fullContent).toContain("full article");
      expect(entry.fullContent).not.toContain("<script>");
      expect(entry.fullContent).not.toContain("onclick");

      const disabledEntry = await entryReadsService.getEntry(db, disabledUserId, entryId);
      expect(disabledEntry.fullContent).toBeNull();
    });
  });
});
