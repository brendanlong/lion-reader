/**
 * Integration tests for entries.get serving DB-cached sanitized HTML.
 *
 * Sanitized entry HTML is persisted in the entries.*_sanitized columns at write
 * time, so the read path serves it directly. When the stored version is stale or
 * missing (pre-migration rows, or after the allow-list was tightened), the read
 * path re-sanitizes from the raw columns and self-heals. These tests verify both
 * behaviors against a real database.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  subscriptionFeeds,
  userEntries,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";
import { SANITIZER_VERSION } from "../../src/server/html/sanitize";
import * as entriesService from "../../src/server/services/entries";

function createAuthContext(userId: string): Context {
  const now = new Date();
  return {
    db,
    session: {
      session: {
        id: generateUuidv7(),
        userId,
        tokenHash: "test-hash",
        userAgent: null,
        ipAddress: null,
        createdAt: now,
        expiresAt: new Date(Date.now() + 3600000),
        revokedAt: null,
        lastActiveAt: now,
      },
      user: {
        id: userId,
        email: `${userId}@test.com`,
        emailVerifiedAt: null,
        tosAgreedAt: now,
        privacyPolicyAgreedAt: now,
        notEuAgreedAt: now,
        passwordHash: "test-hash",
        inviteId: null,
        showSpam: false,
        groqApiKey: null,
        anthropicApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        createdAt: now,
        updatedAt: now,
      },
      hasGroqApiKey: false,
      hasAnthropicApiKey: false,
    },
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

async function seedSubscribedUser(): Promise<{ userId: string; feedId: string }> {
  const userId = generateUuidv7();
  const feedId = generateUuidv7();
  const now = new Date();
  await db.insert(users).values({
    id: userId,
    email: `user-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: now,
    updatedAt: now,
  });
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url: `https://example.com/${feedId}.xml`,
    title: "Test Feed",
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  const subscriptionId = generateUuidv7();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    subscribedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .insert(subscriptionFeeds)
    .values({ subscriptionId, feedId, userId })
    .onConflictDoNothing();
  return { userId, feedId };
}

async function makeEntryVisible(userId: string, entryId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(userEntries)
    .values({ userId, entryId, read: false, starred: false, updatedAt: now });
}

/** Poll until predicate is true (used to observe fire-and-forget heal writes). */
async function eventually(predicate: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (true) {
    if (await predicate()) return;
    if (Date.now() - start > timeoutMs) throw new Error("Condition not met within timeout");
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe("entries.get sanitized content", () => {
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  it("serves the stored sanitized value without re-sanitizing from raw", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = generateUuidv7();
    const now = new Date();
    // Raw content differs from the stored sanitized value: if get served the
    // stored value we see the sentinel; if it re-sanitized raw we'd see "raw".
    await db.insert(entries).values({
      id: entryId,
      feedId,
      type: "web",
      guid: `guid-${entryId}`,
      title: "Stored",
      contentCleaned: "<p>raw uncached</p>",
      contentCleanedSanitized: "<p>STORED_SENTINEL</p>",
      contentSanitizedVersion: SANITIZER_VERSION,
      contentHash: `hash-${entryId}`,
      fetchedAt: now,
      publishedAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await makeEntryVisible(userId, entryId);

    const caller = createCaller(createAuthContext(userId));
    const { entry } = await caller.entries.get({ id: entryId });

    expect(entry.contentCleaned).toBe("<p>STORED_SENTINEL</p>");
  });

  it("re-sanitizes from raw and self-heals when the stored version is missing", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = generateUuidv7();
    const now = new Date();
    // Simulate a pre-migration row: raw content present, no sanitized columns.
    await db.insert(entries).values({
      id: entryId,
      feedId,
      type: "web",
      guid: `guid-${entryId}`,
      title: "Unhealed",
      contentCleaned: '<p onclick="evil()">hello<script>alert(1)</script></p>',
      contentSanitizedVersion: null,
      contentHash: `hash-${entryId}`,
      fetchedAt: now,
      publishedAt: now,
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await makeEntryVisible(userId, entryId);

    const caller = createCaller(createAuthContext(userId));
    const { entry } = await caller.entries.get({ id: entryId });

    // Returned content is sanitized.
    expect(entry.contentCleaned).toContain("hello");
    expect(entry.contentCleaned).not.toContain("<script>");
    expect(entry.contentCleaned).not.toContain("onclick");

    // The heal is persisted (fire-and-forget), so a later read is a stored hit.
    await eventually(async () => {
      const [row] = await db
        .select({
          sanitized: entries.contentCleanedSanitized,
          version: entries.contentSanitizedVersion,
        })
        .from(entries)
        .where(eq(entries.id, entryId));
      return row?.version === SANITIZER_VERSION && (row?.sanitized ?? "").includes("hello");
    });
  });

  // The services-layer getEntry/getEntries are the read path for MCP get_entry,
  // Google Reader, and Wallabag — they must serve sanitized content too, not
  // just the tRPC router (issue #956).
  describe("services getEntry/getEntries", () => {
    it("getEntry serves stored sanitized content, never the raw columns", async () => {
      const { userId, feedId } = await seedSubscribedUser();
      const entryId = generateUuidv7();
      const now = new Date();
      await db.insert(entries).values({
        id: entryId,
        feedId,
        type: "web",
        guid: `guid-${entryId}`,
        title: "Stored",
        contentCleaned: "<p>raw uncached</p>",
        contentCleanedSanitized: "<p>STORED_SENTINEL</p>",
        contentSanitizedVersion: SANITIZER_VERSION,
        contentHash: `hash-${entryId}`,
        fetchedAt: now,
        publishedAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await makeEntryVisible(userId, entryId);

      const entry = await entriesService.getEntry(db, userId, entryId);
      expect(entry.contentCleaned).toBe("<p>STORED_SENTINEL</p>");
    });

    it("getEntry sanitizes unhealed rows instead of returning raw HTML", async () => {
      const { userId, feedId } = await seedSubscribedUser();
      const entryId = generateUuidv7();
      const now = new Date();
      await db.insert(entries).values({
        id: entryId,
        feedId,
        type: "web",
        guid: `guid-${entryId}`,
        title: "Unhealed",
        contentCleaned: '<p onclick="evil()">hello<script>alert(1)</script></p>',
        contentSanitizedVersion: null,
        contentHash: `hash-${entryId}`,
        fetchedAt: now,
        publishedAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      await makeEntryVisible(userId, entryId);

      const entry = await entriesService.getEntry(db, userId, entryId);
      expect(entry.contentCleaned).toContain("hello");
      expect(entry.contentCleaned).not.toContain("<script>");
      expect(entry.contentCleaned).not.toContain("onclick");
    });

    it("getEntries sanitizes every returned entry", async () => {
      const { userId, feedId } = await seedSubscribedUser();
      const now = new Date();
      const entryIds = [generateUuidv7(), generateUuidv7()];
      for (const entryId of entryIds) {
        await db.insert(entries).values({
          id: entryId,
          feedId,
          type: "web",
          guid: `guid-${entryId}`,
          title: "Bulk",
          contentCleaned: `<p>body-${entryId}<script>alert(1)</script></p>`,
          contentSanitizedVersion: null,
          contentHash: `hash-${entryId}`,
          fetchedAt: now,
          publishedAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        });
        await makeEntryVisible(userId, entryId);
      }

      const results = await entriesService.getEntries(db, userId, entryIds);
      expect(results).toHaveLength(2);
      for (const [i, entry] of results.entries()) {
        expect(entry.id).toBe(entryIds[i]);
        expect(entry.contentCleaned).toContain(`body-${entryIds[i]}`);
        expect(entry.contentCleaned).not.toContain("<script>");
      }
    });
  });
});
