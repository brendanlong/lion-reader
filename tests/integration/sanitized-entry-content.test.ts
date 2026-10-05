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
import * as entriesService from "../../src/server/services/entries";
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
      fullContentOriginal: null,
      fullContentCleaned: null,
      userIds: [userId],
    });

    const caller = createCaller(await createAuthContext(userId));
    const { entry } = await caller.entries.get({ id: entryId });
    expect(entry.contentCleaned).toContain("hello");
    expect(entry.fullContentOriginal).toBeNull();
    expect(entry.fullContentCleaned).toBeNull();
  });

  it("serves full-content cleaned (sanitized) and omits original when cleaned exists", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    // The full-content serving rule is `cleaned ?? original`, so when cleaned
    // exists the (whole raw page) original is never displayed — the read path
    // skips sanitizing it and returns null.
    const entryId = await createTestEntry(feedId, {
      title: "Full content",
      contentCleaned: "<p>feed body</p>",
      fullContentOriginal: "<article>whole raw page<script>alert(1)</script></article>",
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
    expect(entry.fullContentOriginal).toBeNull();
  });

  it("sanitizes the full-content original when cleaned is absent", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = await createTestEntry(feedId, {
      title: "Full content original only",
      contentCleaned: "<p>feed body</p>",
      fullContentOriginal: '<article onclick="evil()">raw page<script>alert(1)</script></article>',
      fullContentCleaned: null,
      fullContentHash: "fullhash",
      fullContentFetchedAt: new Date(),
      userIds: [userId],
    });

    const caller = createCaller(await createAuthContext(userId));
    const { entry } = await caller.entries.get({ id: entryId });

    expect(entry.fullContentOriginal).toContain("raw page");
    expect(entry.fullContentOriginal).not.toContain("<script>");
    expect(entry.fullContentOriginal).not.toContain("onclick");
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

      const entry = await entriesService.getEntry(db, userId, entryId);
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

      const results = await entriesService.getEntries(db, userId, entryIds);
      expect(results).toHaveLength(2);
      for (const [i, entry] of results.entries()) {
        expect(entry.id).toBe(entryIds[i]);
        expect(entry.contentCleaned).toContain(`body-${entryIds[i]}`);
        expect(entry.contentCleaned).not.toContain("<script>");
      }
    });

    // Issue #1787: Google Reader/Wallabag clients got the feed teaser even when
    // the subscription fetches full articles.
    it("serves sanitized full content only when the subscription shows it", async () => {
      const fullContentFields = {
        contentCleaned: "<p>teaser</p>",
        fullContentCleaned: '<p onclick="evil()">full article<script>alert(1)</script></p>',
        fullContentHash: "fullhash",
        fullContentFetchedAt: new Date(),
      };

      const enabled = await seedSubscribedUser({ fetchFullContent: true });
      const enabledId = await createTestEntry(enabled.feedId, {
        ...fullContentFields,
        userIds: [enabled.userId],
      });
      const [entry] = await entriesService.getEntries(db, enabled.userId, [enabledId]);
      expect(entry.fullContent).toContain("full article");
      expect(entry.fullContent).not.toContain("<script>");
      expect(entry.fullContent).not.toContain("onclick");

      const disabled = await seedSubscribedUser({ fetchFullContent: false });
      const disabledId = await createTestEntry(disabled.feedId, {
        ...fullContentFields,
        userIds: [disabled.userId],
      });
      const disabledEntry = await entriesService.getEntry(db, disabled.userId, disabledId);
      expect(disabledEntry.fullContent).toBeNull();
    });
  });
});
