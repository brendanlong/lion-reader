/**
 * Integration tests for the sync.events endpoint.
 *
 * Tests that the sync router correctly constructs events from database state changes.
 * Uses a real Postgres database via docker-compose.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq, and, sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  feeds,
  entries,
  subscriptions,
  subscriptionTags,
  userEntries,
  tags,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import { advanceCursors, type SyncCursors } from "../../src/lib/events/cursors";
import type { SyncEvent } from "../../src/lib/events/schemas";
import type { Context } from "../../src/server/trpc/context";

// ============================================================================
// Test Helpers
// ============================================================================

async function createTestUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `sync-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

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
        tosAgreedAt: new Date(),
        privacyPolicyAgreedAt: new Date(),
        notEuAgreedAt: new Date(),
        passwordHash: "test-hash",
        inviteId: null,
        showSpam: false,
        lastActiveAt: null,
        groqApiKey: null,
        anthropicApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        savedUnreadCount: 0,
        starredUnreadCount: 0,
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

async function createTestFeed(url: string, title: string = "Test Feed"): Promise<string> {
  const feedId = generateUuidv7();
  const now = new Date();
  await db.insert(feeds).values({
    id: feedId,
    type: "web",
    url,
    title,
    lastFetchedAt: now,
    lastEntriesUpdatedAt: now,
    createdAt: now,
    updatedAt: now,
  });
  return feedId;
}

async function createTestSubscription(
  userId: string,
  feedId: string,
  options: { subscribedAt?: Date; updatedAt?: Date; customTitle?: string | null } = {}
): Promise<string> {
  const subscriptionId = generateUuidv7();
  const now = options.subscribedAt ?? new Date();
  await db.insert(subscriptions).values({
    id: subscriptionId,
    userId,
    feedId,
    subscribedAt: now,
    customTitle: options.customTitle ?? null,
    createdAt: now,
    updatedAt: options.updatedAt ?? now,
  });
  return subscriptionId;
}

async function createTestEntry(
  feedId: string,
  options: {
    title?: string;
    publishedAt?: Date;
    createdAt?: Date;
    updatedAt?: Date;
  } = {}
): Promise<string> {
  const entryId = generateUuidv7();
  const now = new Date();
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type: "web",
    guid: `guid-${entryId}`,
    title: options.title ?? `Entry ${entryId}`,
    contentHash: `hash-${entryId}`,
    fetchedAt: now,
    publishedAt: options.publishedAt ?? now,
    lastSeenAt: now,
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
  });
  return entryId;
}

async function createSavedFeed(userId: string): Promise<string> {
  const feedId = generateUuidv7();
  const now = new Date();
  await db.insert(feeds).values({
    id: feedId,
    type: "saved",
    userId,
    url: null,
    title: "Saved Articles",
    // Saved feeds are never polled: last_entries_updated_at stays NULL.
    lastEntriesUpdatedAt: null,
    createdAt: now,
    updatedAt: now,
  });
  return feedId;
}

async function createSavedEntry(
  savedFeedId: string,
  options: { title?: string; createdAt?: Date; updatedAt?: Date } = {}
): Promise<string> {
  const entryId = generateUuidv7();
  const now = new Date();
  await db.insert(entries).values({
    id: entryId,
    feedId: savedFeedId,
    type: "saved",
    guid: `guid-${entryId}`,
    title: options.title ?? `Saved ${entryId}`,
    contentHash: `hash-${entryId}`,
    fetchedAt: now,
    publishedAt: options.createdAt ?? now,
    // Saved entries must have last_seen_at NULL (entries_last_seen_only_fetched).
    lastSeenAt: null,
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
  });
  return entryId;
}

async function createUserEntry(
  userId: string,
  entryId: string,
  options: { read?: boolean; starred?: boolean; updatedAt?: Date } = {}
): Promise<void> {
  const now = new Date();
  await db.insert(userEntries).values({
    userId,
    entryId,
    read: options.read ?? false,
    starred: options.starred ?? false,
    readChangedAt: now,
    starredChangedAt: now,
    updatedAt: options.updatedAt ?? now,
  });
}

async function createTestTag(
  userId: string,
  name: string,
  options: { color?: string; createdAt?: Date; updatedAt?: Date; deletedAt?: Date | null } = {}
): Promise<string> {
  const tagId = generateUuidv7();
  const now = new Date();
  await db.insert(tags).values({
    id: tagId,
    userId,
    name,
    color: options.color ?? null,
    createdAt: options.createdAt ?? now,
    updatedAt: options.updatedAt ?? now,
    deletedAt: options.deletedAt ?? null,
  });
  return tagId;
}

async function linkTagToSubscription(tagId: string, subscriptionId: string): Promise<void> {
  await db.insert(subscriptionTags).values({
    tagId,
    subscriptionId,
    createdAt: new Date(),
  });
}

const ENTRY_EVENT_TYPES = new Set(["new_entry", "entry_updated", "entry_state_changed"]);

/**
 * Drives sync.events like the real client does: repeatedly polls, advancing the
 * keyset cursors through the actual `advanceCursors` bookkeeping, until the
 * server reports no more pages. Returns every event collected across pages.
 */
async function drainEntrySync(userId: string, start: SyncCursors): Promise<SyncEvent[]> {
  let cursors = start;
  const collected: SyncEvent[] = [];
  for (let guard = 0; guard < 50; guard++) {
    const result = await createCaller(createAuthContext(userId)).sync.events({
      cursors: {
        entries: cursors.entries ?? undefined,
        entriesAfterId: cursors.entriesAfterId ?? undefined,
        subscriptions: cursors.subscriptions ?? undefined,
        tags: cursors.tags ?? undefined,
      },
    });
    for (const event of result.events as SyncEvent[]) {
      cursors = advanceCursors(cursors, event);
      collected.push(event);
    }
    if (!result.hasMore) return collected;
  }
  throw new Error("drainEntrySync did not terminate");
}

// ============================================================================
// Tests
// ============================================================================

describe("sync.events", () => {
  beforeEach(async () => {
    await db.delete(userEntries);
    await db.delete(subscriptionTags);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(tags);
    await db.delete(feeds);
    await db.delete(users);
  });

  afterAll(async () => {
    await db.delete(userEntries);
    await db.delete(subscriptionTags);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(tags);
    await db.delete(feeds);
    await db.delete(users);
  });

  // ==========================================================================
  // No cursors / empty state
  // ==========================================================================

  it("returns empty events when no cursors provided", async () => {
    const userId = await createTestUser();
    const ctx = createAuthContext(userId);
    const caller = createCaller(ctx);

    const result = await caller.sync.events({ cursors: {} });

    expect(result.events).toEqual([]);
    expect(result.hasMore).toBe(false);
  });

  // ==========================================================================
  // Entry events
  // ==========================================================================

  describe("entry events", () => {
    it("returns new_entry for entry created after cursor", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/sync-feed.xml");
      const subId = await createTestSubscription(userId, feedId);

      // Get cursor before creating entry
      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();
      const baseCursor = cursorResult.entries ?? new Date("2020-01-01").toISOString();

      // Create entry after cursor
      const entryId = await createTestEntry(feedId, { title: "New Post" });
      await createUserEntry(userId, entryId);

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: baseCursor },
      });

      const newEntryEvents = result.events.filter((e) => e.type === "new_entry");
      expect(newEntryEvents).toHaveLength(1);
      expect(newEntryEvents[0]).toMatchObject({
        type: "new_entry",
        entryId,
        subscriptionId: subId,
        feedType: "web",
        // Absolute unread counts the client sets directly. Untagged
        // subscription, so uncategorized is affected rather than any tag.
        counts: {
          all: { unread: 1 },
          starred: { unread: 0 },
          subscriptions: [{ id: subId, unread: 1 }],
          tags: [],
          uncategorized: { unread: 1 },
        },
      });
    });

    it("includes the subscription's tag in new_entry absolute counts", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/tagged-sync-feed.xml");
      const subId = await createTestSubscription(userId, feedId);
      const tagId = await createTestTag(userId, "News");
      await linkTagToSubscription(tagId, subId);

      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();
      const baseCursor = cursorResult.entries ?? new Date("2020-01-01").toISOString();

      const entryId = await createTestEntry(feedId, { title: "Tagged Post" });
      await createUserEntry(userId, entryId);

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: baseCursor },
      });

      const newEntryEvents = result.events.filter((e) => e.type === "new_entry");
      expect(newEntryEvents).toHaveLength(1);
      expect(newEntryEvents[0]).toMatchObject({
        type: "new_entry",
        entryId,
        subscriptionId: subId,
        counts: {
          subscriptions: [{ id: subId, unread: 1 }],
          tags: [{ id: tagId, unread: 1 }],
        },
      });
    });

    it("returns entry_updated for metadata changes after cursor", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/update-feed.xml");
      await createTestSubscription(userId, feedId);

      // Create entry and user_entry
      const entryCreatedAt = new Date("2024-01-01");
      const entryId = await createTestEntry(feedId, {
        title: "Original Title",
        createdAt: entryCreatedAt,
        updatedAt: entryCreatedAt,
      });
      await createUserEntry(userId, entryId, { updatedAt: entryCreatedAt });

      // Get cursor
      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();

      // Update entry metadata
      const newUpdatedAt = new Date();
      await db
        .update(entries)
        .set({ title: "Updated Title", updatedAt: newUpdatedAt })
        .where(eq(entries.id, entryId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: cursorResult.entries! },
      });

      const updatedEvents = result.events.filter((e) => e.type === "entry_updated");
      expect(updatedEvents).toHaveLength(1);
      expect(updatedEvents[0]).toMatchObject({
        type: "entry_updated",
        entryId,
        metadata: expect.objectContaining({ title: "Updated Title" }),
      });
    });

    it("returns entry_state_changed for read/starred changes after cursor", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/state-feed.xml");
      await createTestSubscription(userId, feedId);

      const entryCreatedAt = new Date("2024-01-01");
      const entryId = await createTestEntry(feedId, {
        createdAt: entryCreatedAt,
        updatedAt: entryCreatedAt,
      });
      await createUserEntry(userId, entryId, { updatedAt: entryCreatedAt });

      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();

      // Update state
      const newUpdatedAt = new Date();
      await db
        .update(userEntries)
        .set({ read: true, starred: true, updatedAt: newUpdatedAt })
        .where(eq(userEntries.entryId, entryId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: cursorResult.entries! },
      });

      const stateEvents = result.events.filter((e) => e.type === "entry_state_changed");
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0]).toMatchObject({
        type: "entry_state_changed",
        entryId,
        read: true,
        starred: true,
      });
    });

    it("returns both metadata and state events when both change", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/both-feed.xml");
      await createTestSubscription(userId, feedId);

      const entryCreatedAt = new Date("2024-01-01");
      const entryId = await createTestEntry(feedId, {
        title: "Original",
        createdAt: entryCreatedAt,
        updatedAt: entryCreatedAt,
      });
      await createUserEntry(userId, entryId, { updatedAt: entryCreatedAt });

      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();

      // Update both metadata and state
      const newUpdatedAt = new Date();
      await db
        .update(entries)
        .set({ title: "Changed Title", updatedAt: newUpdatedAt })
        .where(eq(entries.id, entryId));
      await db
        .update(userEntries)
        .set({ starred: true, updatedAt: newUpdatedAt })
        .where(eq(userEntries.entryId, entryId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: cursorResult.entries! },
      });

      const types = result.events.map((e) => e.type);
      expect(types).toContain("entry_updated");
      expect(types).toContain("entry_state_changed");
    });

    it("returns no entry events for entries before cursor", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/before-feed.xml");
      await createTestSubscription(userId, feedId);

      const entryId = await createTestEntry(feedId);
      await createUserEntry(userId, entryId);

      // Get cursor AFTER the entry was created
      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: cursorResult.entries! },
      });

      expect(
        result.events.filter(
          (e) =>
            e.type === "new_entry" || e.type === "entry_updated" || e.type === "entry_state_changed"
        )
      ).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Subscription events
  // ==========================================================================

  describe("subscription events", () => {
    it("returns subscription_created for new subscription", async () => {
      const userId = await createTestUser();

      // Get cursor before creating subscription
      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();
      const baseCursor = cursorResult.subscriptions ?? new Date("2020-01-01").toISOString();

      const feedId = await createTestFeed("https://example.com/sub-create.xml", "Sub Create Feed");
      const subId = await createTestSubscription(userId, feedId);

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { subscriptions: baseCursor },
      });

      const createdEvents = result.events.filter((e) => e.type === "subscription_created");
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]).toMatchObject({
        type: "subscription_created",
        subscriptionId: subId,
        subscription: expect.objectContaining({ id: subId }),
        feed: expect.objectContaining({ type: "web", title: "Sub Create Feed" }),
      });
    });

    it("returns subscription_created with tags", async () => {
      const userId = await createTestUser();

      const baseCursor = new Date("2020-01-01").toISOString();
      const feedId = await createTestFeed("https://example.com/sub-tags.xml");
      const subId = await createTestSubscription(userId, feedId);

      const tagId = await createTestTag(userId, "My Tag", { color: "#aabbcc" });
      await linkTagToSubscription(tagId, subId);

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { subscriptions: baseCursor },
      });

      const createdEvents = result.events.filter((e) => e.type === "subscription_created");
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]).toMatchObject({
        type: "subscription_created",
        subscription: expect.objectContaining({
          tags: [expect.objectContaining({ id: tagId, name: "My Tag", color: "#aabbcc" })],
        }),
      });
    });

    it("returns subscription_updated for property changes", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/sub-update.xml");

      const earlyDate = new Date("2024-01-01");
      const subId = await createTestSubscription(userId, feedId, {
        subscribedAt: earlyDate,
        updatedAt: earlyDate,
      });

      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();

      // Update subscription
      await db
        .update(subscriptions)
        .set({ customTitle: "My Title", updatedAt: new Date() })
        .where(eq(subscriptions.id, subId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { subscriptions: cursorResult.subscriptions! },
      });

      const updatedEvents = result.events.filter((e) => e.type === "subscription_updated");
      expect(updatedEvents).toHaveLength(1);
      expect(updatedEvents[0]).toMatchObject({
        type: "subscription_updated",
        subscriptionId: subId,
        customTitle: "My Title",
      });
    });

    it("returns subscription_deleted for unsubscribed feeds", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/sub-delete.xml");

      const earlyDate = new Date("2024-01-01");
      const subId = await createTestSubscription(userId, feedId, {
        subscribedAt: earlyDate,
        updatedAt: earlyDate,
      });

      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();

      // Soft-delete subscription
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date(), updatedAt: new Date() })
        .where(eq(subscriptions.id, subId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { subscriptions: cursorResult.subscriptions! },
      });

      const deletedEvents = result.events.filter((e) => e.type === "subscription_deleted");
      expect(deletedEvents).toHaveLength(1);
      expect(deletedEvents[0]).toMatchObject({
        type: "subscription_deleted",
        subscriptionId: subId,
      });
    });
  });

  // ==========================================================================
  // Tag events
  // ==========================================================================

  describe("tag events", () => {
    it("returns tag_created for new tag", async () => {
      const userId = await createTestUser();
      const baseCursor = new Date("2020-01-01").toISOString();

      const tagId = await createTestTag(userId, "New Tag", { color: "#123456" });

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { tags: baseCursor },
      });

      const createdEvents = result.events.filter((e) => e.type === "tag_created");
      expect(createdEvents).toHaveLength(1);
      expect(createdEvents[0]).toMatchObject({
        type: "tag_created",
        tag: { id: tagId, name: "New Tag", color: "#123456" },
      });
    });

    it("returns tag_updated for property changes", async () => {
      const userId = await createTestUser();
      const earlyDate = new Date("2024-01-01");
      const tagId = await createTestTag(userId, "Old Name", {
        color: "#000000",
        createdAt: earlyDate,
        updatedAt: earlyDate,
      });

      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();

      await db
        .update(tags)
        .set({ name: "New Name", color: "#ffffff", updatedAt: new Date() })
        .where(eq(tags.id, tagId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { tags: cursorResult.tags! },
      });

      const updatedEvents = result.events.filter((e) => e.type === "tag_updated");
      expect(updatedEvents).toHaveLength(1);
      expect(updatedEvents[0]).toMatchObject({
        type: "tag_updated",
        tag: { id: tagId, name: "New Name", color: "#ffffff" },
      });
    });

    it("returns tag_deleted for soft-deleted tag", async () => {
      const userId = await createTestUser();
      const earlyDate = new Date("2024-01-01");
      const tagId = await createTestTag(userId, "To Delete", {
        createdAt: earlyDate,
        updatedAt: earlyDate,
      });

      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();

      await db
        .update(tags)
        .set({ deletedAt: new Date(), updatedAt: new Date() })
        .where(eq(tags.id, tagId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { tags: cursorResult.tags! },
      });

      const deletedEvents = result.events.filter((e) => e.type === "tag_deleted");
      expect(deletedEvents).toHaveLength(1);
      expect(deletedEvents[0]).toMatchObject({
        type: "tag_deleted",
        tagId,
      });
    });
  });

  // ==========================================================================
  // Sorting and cursor behavior
  // ==========================================================================

  describe("cursor behavior", () => {
    it("events are sorted by timestamp", async () => {
      const userId = await createTestUser();
      const baseCursor = new Date("2020-01-01").toISOString();

      // Create tags at different times
      const tag1Id = await createTestTag(userId, "First", {
        createdAt: new Date("2024-06-01"),
        updatedAt: new Date("2024-06-01"),
      });
      const tag2Id = await createTestTag(userId, "Second", {
        createdAt: new Date("2024-06-02"),
        updatedAt: new Date("2024-06-02"),
      });
      const tag3Id = await createTestTag(userId, "Third", {
        createdAt: new Date("2024-06-03"),
        updatedAt: new Date("2024-06-03"),
      });

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { tags: baseCursor },
      });

      const tagEvents = result.events.filter((e) => e.type === "tag_created");
      expect(tagEvents).toHaveLength(3);

      // Verify they are in chronological order
      const tagIds = tagEvents.map((e) => {
        if (e.type === "tag_created") return e.tag.id;
        return "";
      });
      expect(tagIds).toEqual([tag1Id, tag2Id, tag3Id]);
    });

    it("preserves microsecond precision in cursors", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/precision.xml");
      await createTestSubscription(userId, feedId);

      // Use explicit timestamps to avoid setTimeout and ensure deterministic ordering
      const entry1Time = new Date("2024-06-01T00:00:00.000Z");
      const entry1Id = await createTestEntry(feedId, {
        title: "First",
        createdAt: entry1Time,
        updatedAt: entry1Time,
      });
      await createUserEntry(userId, entry1Id, { updatedAt: entry1Time });

      // Get cursor after first entry - this captures entry1's timestamp
      const midCursor = await createCaller(createAuthContext(userId)).sync.cursors();

      // Create second entry with a later explicit timestamp
      const entry2Time = new Date("2024-06-01T00:00:01.000Z");
      const entry2Id = await createTestEntry(feedId, {
        title: "Second",
        createdAt: entry2Time,
        updatedAt: entry2Time,
      });
      await createUserEntry(userId, entry2Id, { updatedAt: entry2Time });

      // Using the mid cursor should only return the second entry
      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: midCursor.entries! },
      });

      const newEntryEvents = result.events.filter((e) => e.type === "new_entry");
      expect(newEntryEvents).toHaveLength(1);
      expect(newEntryEvents[0]).toMatchObject({ entryId: entry2Id });
    });
  });

  // ==========================================================================
  // Pagination
  // ==========================================================================

  describe("pagination", () => {
    it("sets hasMore when entries exceed limit", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/pagination.xml");
      await createTestSubscription(userId, feedId);
      const baseCursor = new Date("2020-01-01").toISOString();

      // Create 501 entries to exceed MAX_ENTRIES (500)
      // Use raw SQL for performance
      const entryValues = [];
      const userEntryValues = [];
      for (let i = 0; i < 501; i++) {
        const entryId = generateUuidv7();
        const now = new Date();
        entryValues.push({
          id: entryId,
          feedId,
          type: "web" as const,
          guid: `guid-pagination-${i}`,
          title: `Entry ${i}`,
          contentHash: `hash-${i}`,
          fetchedAt: now,
          publishedAt: now,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        });
        userEntryValues.push({
          userId,
          entryId,
          read: false,
          starred: false,
        });
      }

      // Insert in batches to avoid SQL parameter limits
      const batchSize = 100;
      for (let i = 0; i < entryValues.length; i += batchSize) {
        await db.insert(entries).values(entryValues.slice(i, i + batchSize));
        await db.insert(userEntries).values(userEntryValues.slice(i, i + batchSize));
      }

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: baseCursor },
      });

      expect(result.hasMore).toBe(true);
      // MAX_ENTRIES limits DB rows to 500 (after popping the 501st).
      // Each row produces exactly 2 events: new_entry (createdAt > cursor)
      // + entry_state_changed (userEntry.updatedAt > cursor) = 1000 total.
      const entryEvents = result.events.filter(
        (e) =>
          e.type === "new_entry" || e.type === "entry_updated" || e.type === "entry_state_changed"
      );
      expect(entryEvents).toHaveLength(1000);
    }, 30000); // 30s timeout for bulk insert
  });

  // ==========================================================================
  // Keyset pagination within tied-timestamp groups + fail-closed visibility
  // Regression tests for #1080.
  // ==========================================================================

  describe("keyset pagination (#1080)", () => {
    it("pages within a tied-timestamp group using entriesAfterId without losing rows", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/tied.xml");
      await createTestSubscription(userId, feedId);

      // Three entries sharing one exact timestamp (like markAllEntriesRead
      // stamps). Sort them by id so we can reason about the keyset order.
      const tiedTime = new Date("2025-01-01T00:00:00.000Z");
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const id = await createTestEntry(feedId, { createdAt: tiedTime, updatedAt: tiedTime });
        await createUserEntry(userId, id, { updatedAt: tiedTime });
        ids.push(id);
      }
      ids.sort();
      const [first, second, third] = ids;

      // Simulate a page boundary landing exactly on the first tied row: the
      // client's keyset cursor is (tiedTime, first). The OLD strict `> tiedTime`
      // comparison would exclude every remaining tied row (data loss); the
      // keyset must instead return the two rows past `first`.
      const cursorTs = tiedTime.toISOString();
      const afterFirst = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: cursorTs, entriesAfterId: first },
      });
      const afterFirstNewIds = afterFirst.events
        .filter((e) => e.type === "new_entry")
        .map((e) => (e.type === "new_entry" ? e.entryId : ""));
      expect(afterFirstNewIds.sort()).toEqual([second, third]);

      // Cursor past the last tied row → nothing left in the group.
      const afterLast = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: cursorTs, entriesAfterId: third },
      });
      expect(afterLast.events.filter((e) => ENTRY_EVENT_TYPES.has(e.type))).toHaveLength(0);
    });

    it("delivers every row of an oversized tied group across a full drain", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/tied-large.xml");
      await createTestSubscription(userId, feedId);

      // More than MAX_ENTRIES (500) rows sharing ONE timestamp — the exact
      // markAllEntriesRead-over-a-large-backlog shape that used to lose every
      // row past the first page.
      const tiedTime = new Date("2025-02-02T00:00:00.000Z");
      const total = 550;
      const entryValues = [];
      const userEntryValues = [];
      const allIds = new Set<string>();
      for (let i = 0; i < total; i++) {
        const entryId = generateUuidv7();
        allIds.add(entryId);
        entryValues.push({
          id: entryId,
          feedId,
          type: "web" as const,
          guid: `guid-tied-${i}`,
          title: `Tied ${i}`,
          contentHash: `hash-tied-${i}`,
          fetchedAt: tiedTime,
          publishedAt: tiedTime,
          lastSeenAt: tiedTime,
          createdAt: tiedTime,
          updatedAt: tiedTime,
        });
        userEntryValues.push({ userId, entryId, read: false, starred: false, updatedAt: tiedTime });
      }
      const batchSize = 100;
      for (let i = 0; i < entryValues.length; i += batchSize) {
        await db.insert(entries).values(entryValues.slice(i, i + batchSize));
        await db.insert(userEntries).values(userEntryValues.slice(i, i + batchSize));
      }

      // Start just before the tied timestamp and drain to completion, exactly
      // as the client would (multiple pages, keyset-advanced between them).
      const start: SyncCursors = {
        entries: new Date("2025-02-01T00:00:00.000Z").toISOString(),
        entriesAfterId: null,
        subscriptions: null,
        tags: null,
      };
      const events = await drainEntrySync(userId, start);

      const deliveredIds = events
        .filter((e) => e.type === "new_entry")
        .map((e) => (e.type === "new_entry" ? e.entryId : ""));
      // Every tied row delivered exactly once — no loss, no duplication.
      expect(new Set(deliveredIds).size).toBe(total);
      expect(deliveredIds.length).toBe(total);
      expect([...deliveredIds].every((id) => allIds.has(id))).toBe(true);
    }, 30000);
  });

  // ==========================================================================
  // Fail-closed visibility (#1080)
  // ==========================================================================

  describe("visibility (#1080)", () => {
    it("hides an orphaned user_entries row (no active subscription, not starred)", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/orphan.xml");
      // No subscription row → orphaned. Old fail-open
      // predicate leaked this via `NULL IS NULL`; fail-closed must hide it.
      const entryId = await createTestEntry(feedId, {
        createdAt: new Date("2025-03-02T00:00:00.000Z"),
        updatedAt: new Date("2025-03-02T00:00:00.000Z"),
      });
      await createUserEntry(userId, entryId, { updatedAt: new Date("2025-03-02T00:00:00.000Z") });

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: new Date("2025-03-01T00:00:00.000Z").toISOString() },
      });

      expect(result.events.filter((e) => ENTRY_EVENT_TYPES.has(e.type))).toHaveLength(0);
    });

    it("shows an orphaned entry when it is starred (starred exception)", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/orphan-starred.xml");
      const entryId = await createTestEntry(feedId, {
        createdAt: new Date("2025-03-02T00:00:00.000Z"),
        updatedAt: new Date("2025-03-02T00:00:00.000Z"),
      });
      await createUserEntry(userId, entryId, {
        starred: true,
        updatedAt: new Date("2025-03-02T00:00:00.000Z"),
      });

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: new Date("2025-03-01T00:00:00.000Z").toISOString() },
      });

      const entryEvents = result.events.filter((e) => ENTRY_EVENT_TYPES.has(e.type));
      expect(entryEvents.length).toBeGreaterThan(0);
    });

    it("hides entries from an unsubscribed subscription (not starred)", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/unsubscribed.xml");
      // Subscription exists but is soft-deleted (unsubscribed).
      await createTestSubscription(userId, feedId);
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: new Date("2025-03-01T12:00:00.000Z") })
        .where(eq(subscriptions.userId, userId));

      const entryId = await createTestEntry(feedId, {
        createdAt: new Date("2025-03-02T00:00:00.000Z"),
        updatedAt: new Date("2025-03-02T00:00:00.000Z"),
      });
      await createUserEntry(userId, entryId, { updatedAt: new Date("2025-03-02T00:00:00.000Z") });

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: new Date("2025-03-01T00:00:00.000Z").toISOString() },
      });

      expect(result.events.filter((e) => ENTRY_EVENT_TYPES.has(e.type))).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Index-driven candidate union (#1105)
  //
  // The delta is split into arms that each hit an index instead of scanning the
  // user's whole history on a cross-table GREATEST. These tests exercise the
  // arm that Arm A (user_entries.updated_at) can't cover on its own: an
  // entries.updated_at bump with a STALE user_entries.updated_at, across the
  // subscribed-feed arm (B1) and the saved-articles arm (B2), plus the plan
  // shape that guards the indexes stay in use.
  // ==========================================================================

  describe("entry-side changes (#1105)", () => {
    // Timestamps: the entry + user_entry are created well before the cursor, the
    // cursor sits in the middle, and only entries.updated_at moves after it —
    // user_entries.updated_at stays stale, so only the entry-side arm can find it.
    const OLD = new Date("2025-01-01T00:00:00.000Z");
    const CURSOR = new Date("2025-06-01T00:00:00.000Z");
    const NEW = new Date("2025-06-02T00:00:00.000Z");

    it("delivers a content refetch (entries.updated_at bumped, user_entries stale) via the subscribed-feed arm", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/refetch.xml");
      await createTestSubscription(userId, feedId);

      const entryId = await createTestEntry(feedId, {
        title: "Original Title",
        createdAt: OLD,
        updatedAt: OLD,
      });
      await createUserEntry(userId, entryId, { read: true, updatedAt: OLD });

      // A content refetch bumps entries.updated_at AND the feed's
      // last_entries_updated_at (handlers.ts sets it on hasChanges), but never
      // touches the user_entries row — exactly what updateEntryContent does.
      await db
        .update(entries)
        .set({ title: "Updated Title", updatedAt: NEW })
        .where(eq(entries.id, entryId));
      await db.update(feeds).set({ lastEntriesUpdatedAt: NEW }).where(eq(feeds.id, feedId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: CURSOR.toISOString() },
      });

      const updated = result.events.filter((e) => e.type === "entry_updated");
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({
        type: "entry_updated",
        entryId,
        metadata: expect.objectContaining({ title: "Updated Title" }),
      });
      // The stale-but-read state must NOT surface as a state change.
      expect(result.events.filter((e) => e.type === "entry_state_changed")).toHaveLength(0);
    });

    it("delivers a refetch even when the feed's last_entries_updated_at LAGS the entry's updated_at", async () => {
      // Regression guard: feeds.last_entries_updated_at is stamped from the
      // poll's start-time `now`, but each changed entry's updated_at is a later
      // wall-clock write (after fetch+parse), so entry.updated_at is routinely
      // GREATER than the feed's last_entries_updated_at. Here the feed's stamp is
      // BEFORE the cursor while the entry changed AFTER it — a stale-then-fresh
      // window that must still be delivered. A `last_entries_updated_at >= cursor`
      // pre-filter (the original bug) would prune the feed and drop this entry.
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/refetch-lag.xml");
      await createTestSubscription(userId, feedId);
      const entryId = await createTestEntry(feedId, { createdAt: OLD, updatedAt: OLD });
      await createUserEntry(userId, entryId, { updatedAt: OLD });

      // Entry content changed after the cursor; the feed's last_entries_updated_at
      // lags behind it (before the cursor), as production always produces.
      await db.update(entries).set({ updatedAt: NEW }).where(eq(entries.id, entryId));
      await db.update(feeds).set({ lastEntriesUpdatedAt: OLD }).where(eq(feeds.id, feedId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: CURSOR.toISOString() },
      });
      expect(result.events.filter((e) => e.type === "entry_updated")).toHaveLength(1);
    });

    it("delivers a saved-article content update via the saved arm (no subscription row)", async () => {
      const userId = await createTestUser();
      const savedFeedId = await createSavedFeed(userId);
      const entryId = await createSavedEntry(savedFeedId, {
        title: "Saved Original",
        createdAt: OLD,
        updatedAt: OLD,
      });
      // Saved articles have no subscription; the user_entries row alone grants
      // visibility (subscription_id NULL).
      await createUserEntry(userId, entryId, { read: true, updatedAt: OLD });

      // Later full-content fetch bumps entries.updated_at; the saved feed is never
      // polled so its last_entries_updated_at stays NULL — the saved arm keys on
      // the feed id, not last_entries_updated_at.
      await db
        .update(entries)
        .set({ title: "Saved Updated", updatedAt: NEW })
        .where(eq(entries.id, entryId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: CURSOR.toISOString() },
      });

      const updated = result.events.filter((e) => e.type === "entry_updated");
      expect(updated).toHaveLength(1);
      expect(updated[0]).toMatchObject({ type: "entry_updated", entryId });
    });

    it("delivers a content refetch for a STARRED entry on an unsubscribed feed (visible via starred)", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/starred-orphan-refetch.xml");
      await createTestSubscription(userId, feedId);
      // Soft-delete the subscription: the row still exists, so Arm B1 (which
      // drives from subscriptions without the unsubscribed filter) still reaches
      // the feed, and the outer visibility predicate keeps it because it's starred.
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: NEW })
        .where(eq(subscriptions.userId, userId));

      const entryId = await createTestEntry(feedId, { createdAt: OLD, updatedAt: OLD });
      await createUserEntry(userId, entryId, { starred: true, updatedAt: OLD });

      await db.update(entries).set({ updatedAt: NEW }).where(eq(entries.id, entryId));
      await db.update(feeds).set({ lastEntriesUpdatedAt: NEW }).where(eq(feeds.id, feedId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: CURSOR.toISOString() },
      });
      expect(result.events.filter((e) => e.type === "entry_updated")).toHaveLength(1);
    });

    it("does NOT deliver a content refetch for a non-starred entry on an unsubscribed feed", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/unsub-refetch.xml");
      await createTestSubscription(userId, feedId);
      await db
        .update(subscriptions)
        .set({ unsubscribedAt: NEW })
        .where(eq(subscriptions.userId, userId));

      const entryId = await createTestEntry(feedId, { createdAt: OLD, updatedAt: OLD });
      await createUserEntry(userId, entryId, { updatedAt: OLD });

      await db.update(entries).set({ updatedAt: NEW }).where(eq(entries.id, entryId));
      await db.update(feeds).set({ lastEntriesUpdatedAt: NEW }).where(eq(feeds.id, feedId));

      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: CURSOR.toISOString() },
      });
      expect(result.events.filter((e) => ENTRY_EVENT_TYPES.has(e.type))).toHaveLength(0);
    });

    // The whole point of #1105: each candidate arm must SEEK an index, not scan
    // the user's whole history. These EXPLAINs mirror the arms built in
    // src/server/trpc/routers/sync.ts — keep them in sync. enable_seqscan=off
    // makes the planner reveal whether the predicate is index-serviceable at all
    // (on tiny test data it would otherwise seq-scan regardless of the index).
    it("candidate arms seek their indexes, not a full scan (EXPLAIN)", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/explain.xml");
      await createTestSubscription(userId, feedId);
      const savedFeedId = await createSavedFeed(userId);
      // Give both feeds volume with everything before the cursor, so the
      // (feed_id, updated_at) index — which seeks straight past the stale rows —
      // is strictly cheaper than the (feed_id, id) index that must scan + filter.
      for (let i = 0; i < 40; i++) {
        const e = await createTestEntry(feedId, { updatedAt: OLD });
        await createUserEntry(userId, e, { updatedAt: OLD });
        const s = await createSavedEntry(savedFeedId, { updatedAt: OLD });
        await createUserEntry(userId, s, { updatedAt: OLD });
      }
      await db.execute(sql`ANALYZE user_entries`);
      await db.execute(sql`ANALYZE entries`);
      await db.execute(sql`ANALYZE feeds`);
      await db.execute(sql`ANALYZE subscriptions`);

      const cursorTs = sql`${CURSOR.toISOString()}::timestamptz`;

      // Arm A — user_entries.updated_at
      const armA = db
        .select({ entryId: userEntries.entryId })
        .from(userEntries)
        .where(and(eq(userEntries.userId, userId), sql`${userEntries.updatedAt} >= ${cursorTs}`));

      // Arm B1 — entries.updated_at within subscribed feeds (seek per feed)
      const armB1 = db
        .select({ entryId: userEntries.entryId })
        .from(subscriptions)
        .innerJoin(
          entries,
          and(eq(entries.feedId, subscriptions.feedId), sql`${entries.updatedAt} >= ${cursorTs}`)
        )
        .innerJoin(
          userEntries,
          and(eq(userEntries.entryId, entries.id), eq(userEntries.userId, subscriptions.userId))
        )
        .where(eq(subscriptions.userId, userId));

      // Arm B2 — entries.updated_at within the saved feed
      const armB2 = db
        .select({ entryId: userEntries.entryId })
        .from(userEntries)
        .innerJoin(
          entries,
          and(
            eq(entries.id, userEntries.entryId),
            eq(entries.feedId, savedFeedId),
            sql`${entries.updatedAt} >= ${cursorTs}`
          )
        )
        .where(eq(userEntries.userId, userId));

      const explainOf = async (query: { getSQL: () => ReturnType<typeof sql> }) =>
        db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL enable_seqscan = off`);
          const explain = await tx.execute(sql`EXPLAIN ${query.getSQL()}`);
          return explain.rows.map((r) => r["QUERY PLAN"] as string).join("\n");
        });

      const planA = await explainOf(armA);
      expect(planA).toContain("idx_user_entries_updated_at");
      expect(planA).not.toContain("Seq Scan");

      const planB1 = await explainOf(armB1);
      expect(planB1).toContain("idx_entries_feed_updated_at");
      expect(planB1).not.toContain("Seq Scan");

      const planB2 = await explainOf(armB2);
      expect(planB2).toContain("idx_entries_feed_updated_at");
      expect(planB2).not.toContain("Seq Scan");
    });
  });

  // ==========================================================================
  // Microsecond precision (#680, #683)
  // ==========================================================================
  //
  // Postgres stores timestamps at microsecond precision. The sync cursor must
  // preserve those microseconds end-to-end: a JavaScript Date read (millisecond
  // precision) truncates them, landing the cursor in the gap between rows that
  // share a millisecond and silently dropping or re-delivering entries. The pool
  // returns the raw timestamptz string and the router decodes it to a
  // Temporal.Instant, so the microseconds survive.
  describe("microsecond precision", () => {
    it("sync.cursors preserves the microseconds of the newest change", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/us-cursor.xml");
      await createTestSubscription(userId, feedId);
      const entryId = await createTestEntry(feedId);
      await createUserEntry(userId, entryId);

      // Stamp a microsecond-precise updated_at that a millisecond Date cannot
      // represent (…123456, where 456 is sub-millisecond). The cursor is
      // GREATEST(entries.updated_at, user_entries.updated_at), so pin the entry's
      // updated_at older and let the user_entries change be the newest.
      const micros = "2026-03-04T05:06:07.123456Z";
      await db.execute(
        sql`UPDATE entries SET updated_at = '2026-03-04T05:06:07.000000Z'::timestamptz WHERE id = ${entryId}::uuid`
      );
      await db.execute(
        sql`UPDATE user_entries SET updated_at = ${micros}::timestamptz WHERE entry_id = ${entryId}::uuid`
      );

      const cursorResult = await createCaller(createAuthContext(userId)).sync.cursors();
      expect(cursorResult.entries).toBe(micros);
    });

    it("sync.events emits microsecond-precise timestamps that advance the cursor", async () => {
      const userId = await createTestUser();
      const feedId = await createTestFeed("https://example.com/us-events.xml");
      await createTestSubscription(userId, feedId);
      const entryId = await createTestEntry(feedId);
      await createUserEntry(userId, entryId);

      // Two changes in the same millisecond, differing only in microseconds.
      // (No trailing zeros — Temporal.Instant.toString() trims them, so these are
      // the exact strings the router emits.)
      const older = "2026-03-04T05:06:07.100207Z";
      const newer = "2026-03-04T05:06:07.100803Z";
      const pinned = "2026-03-04T05:06:07.100700Z";
      await db.execute(
        sql`UPDATE entries SET updated_at = ${older}::timestamptz WHERE id = ${entryId}::uuid`
      );
      await db.execute(
        sql`UPDATE user_entries SET updated_at = ${newer}::timestamptz WHERE entry_id = ${entryId}::uuid`
      );

      // A cursor pinned to the microsecond just before `newer` must still surface
      // the change — a millisecond-truncated comparison would have already passed it.
      const result = await createCaller(createAuthContext(userId)).sync.events({
        cursors: { entries: pinned },
      });
      const stateEvents = result.events.filter((e) => e.type === "entry_state_changed");
      expect(stateEvents).toHaveLength(1);
      expect(stateEvents[0].updatedAt).toBe(newer);

      // The emitted timestamp advances the keyset cursor forward (it is strictly
      // after the pinned cursor at microsecond precision).
      const advanced = advanceCursors(
        { entries: pinned, entriesAfterId: null, subscriptions: null, tags: null },
        stateEvents[0]
      );
      expect(advanced.entries).toBe(newer);
    });
  });
});
