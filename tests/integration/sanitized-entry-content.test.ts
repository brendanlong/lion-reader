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
import type { Context } from "../../src/server/trpc/context";
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
        scopes: null,
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
        lastActiveAt: null,
        groqApiKey: null,
        anthropicApiKey: null,
        cerebrasApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        narrationModel: null,
        savedUnreadCount: 0,
        starredUnreadCount: 0,
        createdAt: now,
        updatedAt: now,
      },
      hasGroqApiKey: false,
      hasAnthropicApiKey: false,
      hasCerebrasApiKey: false,
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
  return { userId, feedId };
}

async function makeEntryVisible(userId: string, entryId: string): Promise<void> {
  const now = new Date();
  await db
    .insert(userEntries)
    .values({ userId, entryId, read: false, starred: false, updatedAt: now });
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

  it("sanitizes the raw content on read, never returning raw HTML", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = generateUuidv7();
    const now = new Date();
    await db.insert(entries).values({
      id: entryId,
      feedId,
      type: "web",
      guid: `guid-${entryId}`,
      title: "Unsafe",
      contentCleaned: '<p onclick="evil()">hello<script>alert(1)</script></p>',
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

    expect(entry.contentCleaned).toContain("hello");
    expect(entry.contentCleaned).not.toContain("<script>");
    expect(entry.contentCleaned).not.toContain("onclick");
  });

  it("returns null full-content fields when the entry has no full content", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = generateUuidv7();
    const now = new Date();
    await db.insert(entries).values({
      id: entryId,
      feedId,
      type: "web",
      guid: `guid-${entryId}`,
      title: "No full content",
      contentCleaned: "<p>hello</p>",
      fullContentOriginal: null,
      fullContentCleaned: null,
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
    expect(entry.contentCleaned).toContain("hello");
    expect(entry.fullContentOriginal).toBeNull();
    expect(entry.fullContentCleaned).toBeNull();
  });

  it("serves full-content cleaned (sanitized) and omits original when cleaned exists", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = generateUuidv7();
    const now = new Date();
    // The full-content serving rule is `cleaned ?? original`, so when cleaned
    // exists the (whole raw page) original is never displayed — the read path
    // skips sanitizing it and returns null.
    await db.insert(entries).values({
      id: entryId,
      feedId,
      type: "web",
      guid: `guid-${entryId}`,
      title: "Full content",
      contentCleaned: "<p>feed body</p>",
      fullContentOriginal: "<article>whole raw page<script>alert(1)</script></article>",
      fullContentCleaned: '<p onclick="evil()">full cleaned<script>alert(2)</script></p>',
      fullContentHash: `fullhash-${entryId}`,
      fullContentFetchedAt: now,
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

    expect(entry.fullContentCleaned).toContain("full cleaned");
    expect(entry.fullContentCleaned).not.toContain("<script>");
    expect(entry.fullContentCleaned).not.toContain("onclick");
    expect(entry.fullContentOriginal).toBeNull();
  });

  it("sanitizes the full-content original when cleaned is absent", async () => {
    const { userId, feedId } = await seedSubscribedUser();
    const entryId = generateUuidv7();
    const now = new Date();
    await db.insert(entries).values({
      id: entryId,
      feedId,
      type: "web",
      guid: `guid-${entryId}`,
      title: "Full content original only",
      contentCleaned: "<p>feed body</p>",
      fullContentOriginal: '<article onclick="evil()">raw page<script>alert(1)</script></article>',
      fullContentCleaned: null,
      fullContentHash: `fullhash-${entryId}`,
      fullContentFetchedAt: now,
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
      const entryId = generateUuidv7();
      const now = new Date();
      await db.insert(entries).values({
        id: entryId,
        feedId,
        type: "web",
        guid: `guid-${entryId}`,
        title: "Unsafe",
        contentCleaned: '<p onclick="evil()">hello<script>alert(1)</script></p>',
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
