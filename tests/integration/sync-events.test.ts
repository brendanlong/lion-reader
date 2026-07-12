/**
 * Integration tests for the sync.events endpoint.
 *
 * Tests that the sync router correctly constructs events from database state changes.
 * Uses a real Postgres database via docker-compose.
 */

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
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
});
