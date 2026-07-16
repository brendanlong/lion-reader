/**
 * Integration tests for the entry_state_changed SSE events published by the
 * mark-read and star services.
 *
 * markEntriesRead / updateEntryStarred publish entry_state_changed themselves
 * (not at each API boundary), so every caller — the tRPC mutations, the MCP
 * tools, and the hand-written Google Reader / Wallabag compat routes — notifies
 * a user's other tabs/devices for free (issue #1045). These tests call the
 * services directly (the shared chokepoint) and verify that a real state change
 * publishes, while an idempotent replay (an older changedAt losing the
 * *_changed_at guard) publishes nothing.
 *
 * Also covers issue #1118: a same-value re-assert with a FRESH changedAt (the
 * common Google Reader/Wallabag resync pattern) writes the row — it must keep
 * advancing the *_changed_at last-write-wins watermark — but flips nothing the
 * user can see, so it publishes no event and computes no counts. The
 * multi-device T1/T2/T3 tests pin that the watermark still advances on those
 * writes: if it didn't, an older conflicting update would incorrectly win.
 *
 * Uses a real Postgres + Redis via docker-compose.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import Redis from "ioredis";
import { and, eq } from "drizzle-orm";
import { db } from "../../src/server/db";
import { users, feeds, entries, subscriptions, userEntries } from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import * as entriesService from "../../src/server/services/entries";
import { getUserEventsChannel } from "../../src/server/redis/pubsub";

let subscriber: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL must be set for integration tests");
  }
  subscriber = new Redis(redisUrl);
});

afterAll(async () => {
  await subscriber.quit();
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
});

beforeEach(async () => {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
});

async function seedUser(): Promise<string> {
  const userId = generateUuidv7();
  await db.insert(users).values({
    id: userId,
    email: `entry-state-${userId}@test.com`,
    passwordHash: "test-hash",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return userId;
}

async function seedEntry(
  userId: string,
  options: { isSpam?: boolean; type?: "web" | "email" } = {}
): Promise<string> {
  // Spam is only valid on email entries (entries_spam_only_email constraint).
  const type = options.type ?? (options.isSpam ? "email" : "web");
  const now = new Date();
  const feedId = generateUuidv7();
  await db.insert(feeds).values({
    id: feedId,
    type,
    // Email feeds are per-user (feed_type_user_id constraint)
    userId: type === "email" ? userId : null,
    url: `https://example.com/${feedId}`,
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

  const entryId = generateUuidv7();
  await db.insert(entries).values({
    id: entryId,
    feedId,
    type,
    guid: `guid-${entryId}`,
    title: "Entry",
    contentHash: `hash-${entryId}`,
    fetchedAt: now,
    publishedAt: now,
    // last_seen_at is web-only (entries_last_seen_only_fetched constraint)
    lastSeenAt: type === "web" ? now : null,
    createdAt: now,
    updatedAt: now,
    isSpam: options.isSpam ?? false,
  });
  // starred_changed_at is NOT NULL (defaults to now()); seed an explicitly-old
  // value so the positive tests' default changedAt (now) wins the guard.
  await db.insert(userEntries).values({
    userId,
    entryId,
    read: false,
    starred: false,
    starredChangedAt: new Date("2020-01-01T00:00:00Z"),
    updatedAt: now,
  });
  return entryId;
}

// Resolves with the first message on `channel`. Always removes its own listener
// (on match or timeout) so listeners don't accumulate on the shared subscriber.
function waitForMessage(channel: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const listener = (ch: string, message: string) => {
      if (ch !== channel) return;
      cleanup();
      resolve(message);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("Timed out waiting for message"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      subscriber.off("message", listener);
    };
    subscriber.on("message", listener);
  });
}

// Reads the user_entries state row directly, for asserting on the LWW
// watermark columns that the service return value doesn't expose.
async function getUserEntryRow(userId: string, entryId: string) {
  const [row] = await db
    .select({
      read: userEntries.read,
      starred: userEntries.starred,
      readChangedAt: userEntries.readChangedAt,
      starredChangedAt: userEntries.starredChangedAt,
      updatedAt: userEntries.updatedAt,
    })
    .from(userEntries)
    .where(and(eq(userEntries.userId, userId), eq(userEntries.entryId, entryId)));
  return row;
}

// Runs `action`, then waits `quietMs` and asserts no message arrived on `channel`.
async function expectNoMessage(
  channel: string,
  action: () => Promise<unknown>,
  quietMs = 200
): Promise<void> {
  let received = false;
  const listener = (ch: string) => {
    if (ch === channel) received = true;
  };
  subscriber.on("message", listener);
  try {
    await action();
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    expect(received).toBe(false);
  } finally {
    subscriber.off("message", listener);
  }
}

describe("markEntriesRead SSE publishing", () => {
  it("publishes entry_state_changed with absolute counts when an entry changes", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    const { entries: result, counts } = await entriesService.markEntriesRead(
      db,
      userId,
      [{ id: entryId }],
      true
    );
    expect(result[0].read).toBe(true);
    // The service computes counts once and both returns and publishes them.
    expect(counts?.all.unread).toBe(0);

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("entry_state_changed");
    expect(event.entryId).toBe(entryId);
    expect(event.read).toBe(true);
    expect(event.counts.all.unread).toBe(0);
  });

  it("omits the entry list payload when an entry flips to read", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    await entriesService.markEntriesRead(db, userId, [{ id: entryId }], true);

    // Nothing to insert client-side for a read flip, so no payload is fetched.
    const event = JSON.parse(await messagePromise);
    expect(event.read).toBe(true);
    expect(event.entry).toBeUndefined();
    expect(event.feedId).toBeUndefined();
  });

  it("attaches the entry list payload when an entry flips to unread (#1237)", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);
    await entriesService.markEntriesRead(db, userId, [{ id: entryId }], true);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    await entriesService.markEntriesRead(db, userId, [{ id: entryId }], false);

    // The payload mirrors new_entry so a client with the entry in no cached
    // list can insert it into the lists it now belongs to.
    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("entry_state_changed");
    expect(event.entryId).toBe(entryId);
    expect(event.read).toBe(false);
    expect(event.feedType).toBe("web");
    expect(typeof event.feedId).toBe("string");
    expect(typeof event.subscriptionId).toBe("string");
    expect(event.entry).toMatchObject({
      title: "Entry",
      feedTitle: "Test Feed",
    });
    expect(typeof event.entry.fetchedAt).toBe("string");
  });

  it("omits the payload for a spam entry flipping to unread", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId, { isSpam: true });
    await entriesService.markEntriesRead(db, userId, [{ id: entryId }], true);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    await entriesService.markEntriesRead(db, userId, [{ id: entryId }], false);

    // The default entries.list filters spam, so a client-side insert would
    // show a row the server never returns (same rule as new_entry).
    const event = JSON.parse(await messagePromise);
    expect(event.read).toBe(false);
    expect(event.entry).toBeUndefined();
  });

  it("does not publish when an idempotent replay changes nothing", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    // Establish a recent read_changed_at.
    await entriesService.markEntriesRead(db, userId, [{ id: entryId }], true, {});

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    // Replaying an older action loses the read_changed_at <= changedAt guard, so
    // no row updates and nothing is published.
    await expectNoMessage(channel, () =>
      entriesService.markEntriesRead(db, userId, [{ id: entryId, changedAt: new Date(0) }], false)
    );
  });

  it("does not publish or compute counts when re-asserting an already-read entry (issue #1118)", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    const t1 = new Date("2026-01-01T00:00:01Z");
    const t2 = new Date("2026-01-01T00:00:05Z");
    await entriesService.markEntriesRead(db, userId, [{ id: entryId, changedAt: t1 }], true);

    // Capture updated_at (the delta-sync "meaningful change" timestamp) after
    // the real flip so we can assert the re-assert leaves it untouched.
    const before = await getUserEntryRow(userId, entryId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    // A FRESH changedAt wins the guard and writes the row (the watermark must
    // advance), but the read value doesn't flip — so nothing is published,
    // `changed` is empty, and no counts are computed.
    await expectNoMessage(channel, async () => {
      const result = await entriesService.markEntriesRead(
        db,
        userId,
        [{ id: entryId, changedAt: t2 }],
        true
      );
      expect(result.entries[0].read).toBe(true);
      expect(result.changed).toEqual([]);
      expect(result.counts).toBeUndefined();
    });

    // The re-assert advanced the LWW watermark even though nothing flipped...
    const row = await getUserEntryRow(userId, entryId);
    expect(row.readChangedAt).toEqual(t2);
    // ...but updated_at did NOT move, so delta sync (sync.events / Wallabag
    // `since`) won't re-deliver the entry (issue #1118 Part 2).
    expect(row.updatedAt).toEqual(before.updatedAt);
  });

  it("keeps multi-device last-writer-wins intact across a redundant re-assert (issue #1118)", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    // Wall-clock order of user intent: read@T1, unread@T3, read@T2 — but the
    // redundant read@T2 (latest intent) ARRIVES before the unread@T3 (e.g. a
    // slow offline device syncing late). The result must be "read": the
    // re-assert at T2 advanced the watermark, so the older unread@T3 loses.
    const t1 = new Date("2026-01-01T00:00:01Z");
    const t3 = new Date("2026-01-01T00:00:03Z");
    const t2 = new Date("2026-01-01T00:00:05Z");

    await entriesService.markEntriesRead(db, userId, [{ id: entryId, changedAt: t1 }], true);
    await entriesService.markEntriesRead(db, userId, [{ id: entryId, changedAt: t2 }], true);
    const stale = await entriesService.markEntriesRead(
      db,
      userId,
      [{ id: entryId, changedAt: t3 }],
      false
    );

    // The unread@T3 was rejected by the watermark and flipped nothing.
    expect(stale.changed).toEqual([]);
    expect(stale.entries[0].read).toBe(true);

    const row = await getUserEntryRow(userId, entryId);
    expect(row.read).toBe(true);
    expect(row.readChangedAt).toEqual(t2);
  });

  it("publishes and counts only the flipped entries in a mixed batch", async () => {
    const userId = await seedUser();
    const unreadEntryId = await seedEntry(userId);
    const readEntryId = await seedEntry(userId);
    await entriesService.markEntriesRead(db, userId, [{ id: readEntryId }], true);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    // One entry flips unread→read, the other is a same-value re-assert.
    const result = await entriesService.markEntriesRead(
      db,
      userId,
      [{ id: unreadEntryId }, { id: readEntryId }],
      true
    );

    expect(result.entries).toHaveLength(2);
    expect(result.changed.map((e) => e.id)).toEqual([unreadEntryId]);
    expect(result.counts).toBeDefined();

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("entry_state_changed");
    expect(event.entryId).toBe(unreadEntryId);
  });
});

describe("updateEntryStarred SSE publishing", () => {
  it("publishes entry_state_changed with absolute counts when starring", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const messagePromise = waitForMessage(channel);

    const { entry, counts } = await entriesService.updateEntryStarred(db, userId, entryId, true);
    expect(entry.starred).toBe(true);
    expect(counts?.starred.unread).toBe(1);

    const event = JSON.parse(await messagePromise);
    expect(event.type).toBe("entry_state_changed");
    expect(event.entryId).toBe(entryId);
    expect(event.starred).toBe(true);
    expect(event.counts.starred.unread).toBe(1);
  });

  it("does not publish when an idempotent replay changes nothing", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    // Establish a recent starred_changed_at.
    await entriesService.updateEntryStarred(db, userId, entryId, true, new Date());

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    // Replaying an older action loses the starred_changed_at <= changedAt guard.
    await expectNoMessage(channel, () =>
      entriesService.updateEntryStarred(db, userId, entryId, false, new Date(0))
    );
  });

  it("does not publish or compute counts when re-asserting an already-starred entry (issue #1118)", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    const t1 = new Date("2026-01-01T00:00:01Z");
    const t2 = new Date("2026-01-01T00:00:05Z");
    await entriesService.updateEntryStarred(db, userId, entryId, true, t1);

    // Capture updated_at (the delta-sync "meaningful change" timestamp) after
    // the real flip so we can assert the re-assert leaves it untouched.
    const before = await getUserEntryRow(userId, entryId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    // A FRESH changedAt wins the guard and writes the row (the watermark must
    // advance), but the starred value doesn't flip — so nothing is published
    // and no counts are computed.
    await expectNoMessage(channel, async () => {
      const result = await entriesService.updateEntryStarred(db, userId, entryId, true, t2);
      expect(result.entry.starred).toBe(true);
      expect(result.counts).toBeUndefined();
    });

    // The re-assert advanced the LWW watermark even though nothing flipped...
    const row = await getUserEntryRow(userId, entryId);
    expect(row.starredChangedAt).toEqual(t2);
    // ...but updated_at did NOT move, so delta sync won't re-deliver the entry
    // (issue #1118 Part 2).
    expect(row.updatedAt).toEqual(before.updatedAt);
  });

  it("keeps multi-device last-writer-wins intact across a redundant re-assert (issue #1118)", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    // star@T1, redundant star@T2 arrives before unstar@T3 (T1 < T3 < T2).
    // Latest intent is the T2 star, so the entry must stay starred — which
    // requires the redundant T2 write to have advanced the watermark.
    const t1 = new Date("2026-01-01T00:00:01Z");
    const t3 = new Date("2026-01-01T00:00:03Z");
    const t2 = new Date("2026-01-01T00:00:05Z");

    await entriesService.updateEntryStarred(db, userId, entryId, true, t1);
    await entriesService.updateEntryStarred(db, userId, entryId, true, t2);
    const stale = await entriesService.updateEntryStarred(db, userId, entryId, false, t3);

    // The unstar@T3 was rejected by the watermark.
    expect(stale.entry.starred).toBe(true);

    const row = await getUserEntryRow(userId, entryId);
    expect(row.starred).toBe(true);
    expect(row.starredChangedAt).toEqual(t2);
  });
});

describe("updateEntriesStarred (bulk) SSE publishing", () => {
  it("stars multiple entries in one call and publishes an event per flip", async () => {
    const userId = await seedUser();
    const entryA = await seedEntry(userId);
    const entryB = await seedEntry(userId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);
    const first = waitForMessage(channel);

    const {
      entries: state,
      changed,
      counts,
    } = await entriesService.updateEntriesStarred(db, userId, [entryA, entryB], true);
    expect(state.every((e) => e.starred)).toBe(true);
    expect(changed.map((e) => e.id).sort()).toEqual([entryA, entryB].sort());
    // Both entries are now starred, so the starred badge reflects both.
    expect(counts?.starred.unread).toBe(2);

    const event = JSON.parse(await first);
    expect(event.type).toBe("entry_state_changed");
    expect([entryA, entryB]).toContain(event.entryId);
    expect(event.starred).toBe(true);
    expect(event.counts.starred.unread).toBe(2);

    // Both rows were actually written.
    expect((await getUserEntryRow(userId, entryA)).starred).toBe(true);
    expect((await getUserEntryRow(userId, entryB)).starred).toBe(true);
  });

  it("rejects more than 1000 entries", async () => {
    const userId = await seedUser();
    const ids = Array.from({ length: 1001 }, () => generateUuidv7());
    await expect(entriesService.updateEntriesStarred(db, userId, ids, true)).rejects.toThrow(
      /Maximum 1000 entries/
    );
  });

  it("does not publish or compute counts when re-asserting already-starred entries (issue #1118)", async () => {
    const userId = await seedUser();
    const entryId = await seedEntry(userId);

    const t1 = new Date("2026-01-01T00:00:01Z");
    const t2 = new Date("2026-01-01T00:00:05Z");
    await entriesService.updateEntriesStarred(db, userId, [entryId], true, t1);

    const before = await getUserEntryRow(userId, entryId);

    const channel = getUserEventsChannel(userId);
    await subscriber.subscribe(channel);

    // A fresh changedAt advances the watermark, but the value doesn't flip, so
    // nothing is published and no counts are computed.
    await expectNoMessage(channel, async () => {
      const result = await entriesService.updateEntriesStarred(db, userId, [entryId], true, t2);
      expect(result.changed).toHaveLength(0);
      expect(result.counts).toBeUndefined();
    });

    const row = await getUserEntryRow(userId, entryId);
    expect(row.starredChangedAt).toEqual(t2);
    expect(row.updatedAt).toEqual(before.updatedAt);
  });
});
