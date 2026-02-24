/**
 * Performance profiling tests for entries.markRead and entries.setStarred endpoints.
 *
 * These tests create realistic data volumes and time each phase of the mutation
 * to identify bottlenecks (UPDATE, visibleEntries SELECT, count queries, Redis pub/sub).
 *
 * Run with: pnpm test:integration -- tests/integration/entries-perf.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/server/db";

/** Helper to create a SQL uuid array literal for use with ANY() */
function sqlUuidArray(ids: string[]) {
  return sql.raw(`ARRAY[${ids.map((id) => `'${id}'`).join(",")}]::uuid[]`);
}
import {
  users,
  feeds,
  entries,
  subscriptions,
  userEntries,
  tags,
  subscriptionTags,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";

// ============================================================================
// Configuration
// ============================================================================

/** Number of feeds to create per user */
const NUM_FEEDS = 20;

/** Number of entries per feed */
const ENTRIES_PER_FEED = 50;

/** Total entries per user: NUM_FEEDS * ENTRIES_PER_FEED = 1000
 *
 * For profiling, increase to NUM_FEEDS=50, ENTRIES_PER_FEED=100 (5000 entries).
 * At 5K entries, the bottlenecks become clearly visible:
 *
 * setStarred decomposed (5K entries):
 *   1. UPDATE user_entries:                     4.8ms  (6.8%)
 *   2. SELECT visible_entries (1 entry):        0.6ms  (0.9%)
 *   3a. getEntryRelatedCounts: global scan:    19.6ms (27.8%) << visible_entries full scan
 *   3b. subscription count:                     4.5ms  (6.4%)
 *   3c. tag counts:                            40.8ms (57.8%) << BOTTLENECK
 *   4. Redis publish:                           0.3ms  (0.4%)
 *   TOTAL:                                     70.6ms
 *
 * markRead decomposed (5K entries, 10 entry batch):
 *   1. UPDATE user_entries:                     1.4ms  (0.5%)
 *   2. SELECT visible_entries (10 entries):     1.0ms  (0.4%)
 *   3a. getBulkCounts: global scan:            18.9ms  (6.8%) << visible_entries full scan
 *   3b. per-subscription counts:                4.5ms  (1.6%)
 *   3c. tag lookups:                            0.3ms  (0.1%)
 *   3d. tag unread counts:                     36.8ms (13.3%) << tag JOIN through view
 *   3e. uncategorized count:                  214.3ms (77.3%) << BOTTLENECK
 *   TOTAL:                                    277.3ms
 *
 * Key finding: the actual mutations (UPDATE, SELECT) are fast (<5ms).
 * 90%+ of latency is in the count queries that scan visible_entries view.
 * visible_entries is a 4-way join (user_entries + entries + subscriptions + predictions).
 * The uncategorized count uses NOT EXISTS with the user_feeds view, compounding the cost.
 * At production scale (10K-50K entries), these queries likely reach 500-800ms+.
 */

/** Number of tags */
const NUM_TAGS = 5;

// ============================================================================
// Helpers
// ============================================================================

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
        passwordHash: "test-hash",
        inviteId: null,
        showSpam: false,
        algorithmicFeedEnabled: true,
        groqApiKey: null,
        anthropicApiKey: null,
        summarizationModel: null,
        summarizationMaxWords: null,
        summarizationPrompt: null,
        bestFeedScoreWeight: 1,
        bestFeedUncertaintyWeight: 1,
        createdAt: now,
        updatedAt: now,
      },
    },
    apiToken: null,
    authType: "session",
    scopes: [],
    sessionToken: "test-token",
    headers: new Headers(),
  };
}

interface Timing {
  label: string;
  ms: number;
}

function printTimings(label: string, timings: Timing[]) {
  console.log(`\n=== ${label} ===`);
  const total = timings.reduce((sum, t) => sum + t.ms, 0);
  for (const t of timings) {
    const pct = ((t.ms / total) * 100).toFixed(1);
    console.log(`  ${t.label}: ${t.ms.toFixed(1)}ms (${pct}%)`);
  }
  console.log(`  TOTAL: ${total.toFixed(1)}ms`);
}

async function timeAsync<T>(
  label: string,
  fn: () => Promise<T>
): Promise<{ result: T; timing: Timing }> {
  const start = performance.now();
  const result = await fn();
  const ms = performance.now() - start;
  return { result, timing: { label, ms } };
}

// ============================================================================
// Test Setup
// ============================================================================

let testUserId: string;
const testEntryIds: string[] = [];
const testFeedIds: string[] = [];
const testSubscriptionIds: string[] = [];
const testTagIds: string[] = [];

describe("Entries Performance Profiling", () => {
  beforeAll(async () => {
    // Clean up any previous test data
    await db.delete(subscriptionTags);
    await db.delete(tags).where(sql`true`);
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);

    console.log("\n--- Setting up test data ---");
    const setupStart = performance.now();

    // Create user
    testUserId = generateUuidv7();
    await db.insert(users).values({
      id: testUserId,
      email: `perf-test-${testUserId}@test.com`,
      passwordHash: "test-hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create tags
    for (let t = 0; t < NUM_TAGS; t++) {
      const tagId = generateUuidv7();
      testTagIds.push(tagId);
      await db.insert(tags).values({
        id: tagId,
        userId: testUserId,
        name: `Tag ${t}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    // Create feeds, subscriptions, entries, and user_entries in batches
    for (let f = 0; f < NUM_FEEDS; f++) {
      const feedId = generateUuidv7();
      testFeedIds.push(feedId);
      const now = new Date();

      await db.insert(feeds).values({
        id: feedId,
        type: "web",
        url: `https://perf-test-${f}.example.com/feed.xml`,
        title: `Perf Feed ${f}`,
        lastFetchedAt: now,
        lastEntriesUpdatedAt: now,
        createdAt: now,
        updatedAt: now,
      });

      const subId = generateUuidv7();
      testSubscriptionIds.push(subId);
      await db.insert(subscriptions).values({
        id: subId,
        userId: testUserId,
        feedId,
        subscribedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000), // 1 year ago
        createdAt: now,
        updatedAt: now,
      });

      // Assign each subscription to 1-2 tags (some uncategorized)
      if (f < NUM_FEEDS - 3) {
        // Leave 3 subscriptions uncategorized
        const tagIdx = f % NUM_TAGS;
        await db.insert(subscriptionTags).values({
          subscriptionId: subId,
          tagId: testTagIds[tagIdx],
        });
      }

      // Create entries in batch
      const entryBatch = [];
      const userEntryBatch = [];
      for (let e = 0; e < ENTRIES_PER_FEED; e++) {
        const entryId = generateUuidv7();
        testEntryIds.push(entryId);
        const entryTime = new Date(
          Date.now() - (NUM_FEEDS * ENTRIES_PER_FEED - (f * ENTRIES_PER_FEED + e)) * 60000
        );

        entryBatch.push({
          id: entryId,
          feedId,
          type: "web" as const,
          guid: `guid-${entryId}`,
          title: `Entry ${f}-${e}`,
          contentCleaned: `Content for entry ${f}-${e}. This is test content.`,
          contentHash: `hash-${entryId}`,
          fetchedAt: entryTime,
          publishedAt: entryTime,
          lastSeenAt: now,
          createdAt: now,
          updatedAt: now,
        });

        userEntryBatch.push({
          userId: testUserId,
          entryId,
          read: e < ENTRIES_PER_FEED / 2, // half read, half unread
          starred: e % 10 === 0, // 10% starred
          readChangedAt: entryTime,
          starredChangedAt: entryTime,
          updatedAt: now,
        });
      }

      await db.insert(entries).values(entryBatch);
      await db.insert(userEntries).values(userEntryBatch);
    }

    const setupMs = performance.now() - setupStart;
    console.log(
      `Setup: ${testEntryIds.length} entries across ${NUM_FEEDS} feeds in ${setupMs.toFixed(0)}ms`
    );

    // Print table sizes for reference
    const [entryCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(userEntries)
      .where(eq(userEntries.userId, testUserId));
    console.log(`user_entries rows for test user: ${entryCount.count}`);
  }, 120000);

  afterAll(async () => {
    await db.delete(subscriptionTags);
    await db.delete(tags).where(sql`true`);
    await db.delete(userEntries);
    await db.delete(entries);
    await db.delete(subscriptions);
    await db.delete(feeds);
    await db.delete(users);
  });

  // ============================================================================
  // Granular query profiling (bypasses tRPC, tests raw SQL performance)
  // ============================================================================

  describe("Raw query profiling", () => {
    it("profiles the visible_entries view for a single entry lookup", async () => {
      const entryId = testEntryIds[0];
      const timings: Timing[] = [];

      // 1. Direct user_entries lookup by PK
      const { timing: t1 } = await timeAsync("user_entries PK lookup", () =>
        db
          .select()
          .from(userEntries)
          .where(sql`${userEntries.userId} = ${testUserId} AND ${userEntries.entryId} = ${entryId}`)
      );
      timings.push(t1);

      // 2. visible_entries lookup for one entry
      const { timing: t2 } = await timeAsync("visible_entries single entry", () =>
        db.execute(sql`
          SELECT ve.id, ve.read, ve.starred, ve.updated_at, ve.score, ve.subscription_id, ve.type
          FROM visible_entries ve
          WHERE ve.user_id = ${testUserId} AND ve.id = ${entryId}
        `)
      );
      timings.push(t2);

      // 3. visible_entries lookup for 10 entries
      const tenIds = testEntryIds.slice(0, 10);
      const { timing: t3 } = await timeAsync("visible_entries 10 entries", () =>
        db.execute(sql`
          SELECT ve.id, ve.read, ve.starred, ve.updated_at, ve.score, ve.subscription_id, ve.type
          FROM visible_entries ve
          WHERE ve.user_id = ${testUserId} AND ve.id = ANY(${sqlUuidArray(tenIds)})
        `)
      );
      timings.push(t3);

      // 4. Global count through visible_entries (the expensive one)
      const { timing: t4 } = await timeAsync("visible_entries global COUNT(*)", () =>
        db.execute(sql`
          SELECT
            count(*)::int as all_total,
            count(*) FILTER (WHERE NOT read)::int as all_unread,
            count(*) FILTER (WHERE starred)::int as starred_total,
            count(*) FILTER (WHERE starred AND NOT read)::int as starred_unread,
            count(*) FILTER (WHERE type = 'saved')::int as saved_total,
            count(*) FILTER (WHERE type = 'saved' AND NOT read)::int as saved_unread
          FROM visible_entries
          WHERE user_id = ${testUserId}
        `)
      );
      timings.push(t4);

      // 5. Same count but directly on user_entries (no view)
      const { timing: t5 } = await timeAsync("user_entries direct COUNT(*)", () =>
        db.execute(sql`
          SELECT
            count(*)::int as all_total,
            count(*) FILTER (WHERE NOT ue.read)::int as all_unread,
            count(*) FILTER (WHERE ue.starred)::int as starred_total,
            count(*) FILTER (WHERE ue.starred AND NOT ue.read)::int as starred_unread
          FROM user_entries ue
          WHERE ue.user_id = ${testUserId}
        `)
      );
      timings.push(t5);

      // 6. Count using partial indexes
      const { timing: t6 } = await timeAsync("unread count via partial index", () =>
        db.execute(sql`
          SELECT count(*)::int as unread
          FROM user_entries
          WHERE user_id = ${testUserId} AND read = false
        `)
      );
      timings.push(t6);

      // 7. Subscription-specific count through visible_entries
      const subId = testSubscriptionIds[0];
      const { timing: t7 } = await timeAsync("visible_entries subscription COUNT", () =>
        db.execute(sql`
          SELECT count(*) FILTER (WHERE NOT read)::int as unread
          FROM visible_entries
          WHERE user_id = ${testUserId} AND subscription_id = ${subId}
        `)
      );
      timings.push(t7);

      // 8. Tag count query (like getSubscriptionTagCounts)
      const tagId = testTagIds[0];
      const { timing: t8 } = await timeAsync("tag unread COUNT via subscription_tags JOIN", () =>
        db.execute(sql`
          SELECT st.tag_id, count(*) FILTER (WHERE NOT ve.read)::int as unread
          FROM subscription_tags st
          INNER JOIN visible_entries ve ON ve.subscription_id = st.subscription_id
          WHERE ve.user_id = ${testUserId} AND st.tag_id = ${tagId}
          GROUP BY st.tag_id
        `)
      );
      timings.push(t8);

      printTimings("Raw Query Profiling", timings);

      // Assertions to keep test framework happy
      expect(t1.ms).toBeLessThan(5000);
    });

    it("profiles EXPLAIN ANALYZE for global counts through visible_entries", async () => {
      const result = await db.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT
          count(*)::int as all_total,
          count(*) FILTER (WHERE NOT read)::int as all_unread,
          count(*) FILTER (WHERE starred)::int as starred_total,
          count(*) FILTER (WHERE starred AND NOT read)::int as starred_unread,
          count(*) FILTER (WHERE type = 'saved')::int as saved_total,
          count(*) FILTER (WHERE type = 'saved' AND NOT read)::int as saved_unread
        FROM visible_entries
        WHERE user_id = ${testUserId}
      `);

      console.log("\n=== EXPLAIN ANALYZE: Global counts via visible_entries ===");
      for (const row of result.rows) {
        console.log("  " + (row as Record<string, string>)["QUERY PLAN"]);
      }

      expect(result.rows.length).toBeGreaterThan(0);
    });

    it("profiles EXPLAIN ANALYZE for direct user_entries counts", async () => {
      const result = await db.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT
          count(*)::int as all_total,
          count(*) FILTER (WHERE NOT ue.read)::int as all_unread,
          count(*) FILTER (WHERE ue.starred)::int as starred_total,
          count(*) FILTER (WHERE ue.starred AND NOT ue.read)::int as starred_unread
        FROM user_entries ue
        WHERE ue.user_id = ${testUserId}
      `);

      console.log("\n=== EXPLAIN ANALYZE: Direct user_entries counts ===");
      for (const row of result.rows) {
        console.log("  " + (row as Record<string, string>)["QUERY PLAN"]);
      }

      expect(result.rows.length).toBeGreaterThan(0);
    });

    it("profiles EXPLAIN ANALYZE for visible_entries single entry lookup", async () => {
      const entryId = testEntryIds[0];
      const result = await db.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT ve.id, ve.read, ve.starred, ve.updated_at, ve.score, ve.subscription_id, ve.type
        FROM visible_entries ve
        WHERE ve.user_id = ${testUserId} AND ve.id = ${entryId}
      `);

      console.log("\n=== EXPLAIN ANALYZE: visible_entries single entry ===");
      for (const row of result.rows) {
        console.log("  " + (row as Record<string, string>)["QUERY PLAN"]);
      }

      expect(result.rows.length).toBeGreaterThan(0);
    });

    it("profiles alternative: counts from user_entries + entries join (no subscriptions join)", async () => {
      const subId = testSubscriptionIds[0];
      const timings: Timing[] = [];

      // Global counts from user_entries alone (no type info)
      const { timing: t1 } = await timeAsync("user_entries only: global counts", () =>
        db.execute(sql`
          SELECT
            count(*)::int as all_total,
            count(*) FILTER (WHERE NOT ue.read)::int as all_unread,
            count(*) FILTER (WHERE ue.starred)::int as starred_total,
            count(*) FILTER (WHERE ue.starred AND NOT ue.read)::int as starred_unread
          FROM user_entries ue
          WHERE ue.user_id = ${testUserId}
        `)
      );
      timings.push(t1);

      // Type-aware counts using entries join only (skip subscriptions + predictions)
      const { timing: t2 } = await timeAsync("user_entries + entries: type-aware counts", () =>
        db.execute(sql`
          SELECT
            count(*)::int as all_total,
            count(*) FILTER (WHERE NOT ue.read)::int as all_unread,
            count(*) FILTER (WHERE ue.starred)::int as starred_total,
            count(*) FILTER (WHERE ue.starred AND NOT ue.read)::int as starred_unread,
            count(*) FILTER (WHERE e.type = 'saved')::int as saved_total,
            count(*) FILTER (WHERE e.type = 'saved' AND NOT ue.read)::int as saved_unread
          FROM user_entries ue
          JOIN entries e ON e.id = ue.entry_id
          WHERE ue.user_id = ${testUserId}
        `)
      );
      timings.push(t2);

      // Subscription count using subscriptions table directly (no array containment)
      const { timing: t3 } = await timeAsync("subscription count via subscriptions.id direct", () =>
        db.execute(sql`
          SELECT count(*) FILTER (WHERE NOT ue.read)::int as unread
          FROM user_entries ue
          JOIN entries e ON e.id = ue.entry_id
          JOIN subscriptions s ON s.feed_id = e.feed_id AND s.user_id = ue.user_id AND s.unsubscribed_at IS NULL
          WHERE ue.user_id = ${testUserId} AND s.id = ${subId}
        `)
      );
      timings.push(t3);

      printTimings("Alternative Count Strategies", timings);
      expect(t1.ms).toBeLessThan(5000);
    });
  });

  // ============================================================================
  // End-to-end tRPC endpoint profiling
  // ============================================================================

  describe("tRPC endpoint profiling", () => {
    it("profiles entries.setStarred end-to-end", async () => {
      const ctx = createAuthContext(testUserId);
      const caller = createCaller(ctx);

      // Pick an unstarred entry
      const entryId = testEntryIds[100]; // somewhere in the middle

      const timings: Timing[] = [];

      // Time the full endpoint
      const { timing: tTotal } = await timeAsync("setStarred (star) TOTAL", () =>
        caller.entries.setStarred({ id: entryId, starred: true })
      );
      timings.push(tTotal);

      // Unstar it back
      const { timing: tUnstar } = await timeAsync("setStarred (unstar) TOTAL", () =>
        caller.entries.setStarred({ id: entryId, starred: false })
      );
      timings.push(tUnstar);

      // Run 5 more iterations for consistency
      for (let i = 0; i < 5; i++) {
        const eid = testEntryIds[200 + i];
        const { timing } = await timeAsync(`setStarred iteration ${i + 1}`, () =>
          caller.entries.setStarred({ id: eid, starred: true })
        );
        timings.push(timing);
      }

      printTimings("entries.setStarred E2E", timings);

      // Calculate statistics
      const times = timings.map((t) => t.ms);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const p50 = times.sort((a, b) => a - b)[Math.floor(times.length / 2)];
      console.log(`  Average: ${avg.toFixed(1)}ms, P50: ${p50.toFixed(1)}ms`);

      expect(tTotal.ms).toBeLessThan(10000);
    });

    it("profiles entries.markRead with 1 entry", async () => {
      const ctx = createAuthContext(testUserId);
      const caller = createCaller(ctx);
      const timings: Timing[] = [];

      for (let i = 0; i < 5; i++) {
        const entryId = testEntryIds[300 + i];
        const { timing } = await timeAsync(`markRead(1) iteration ${i + 1}`, () =>
          caller.entries.markRead({
            entries: [{ id: entryId }],
            read: true,
            fromList: true,
          })
        );
        timings.push(timing);
      }

      printTimings("entries.markRead (1 entry) E2E", timings);

      const times = timings.map((t) => t.ms);
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      console.log(`  Average: ${avg.toFixed(1)}ms`);

      expect(times[0]).toBeLessThan(10000);
    });

    it("profiles entries.markRead with 10 entries", async () => {
      const ctx = createAuthContext(testUserId);
      const caller = createCaller(ctx);
      const timings: Timing[] = [];

      for (let i = 0; i < 3; i++) {
        const entryIds = testEntryIds.slice(400 + i * 10, 410 + i * 10);
        const { timing } = await timeAsync(`markRead(10) iteration ${i + 1}`, () =>
          caller.entries.markRead({
            entries: entryIds.map((id) => ({ id })),
            read: true,
            fromList: true,
          })
        );
        timings.push(timing);
      }

      printTimings("entries.markRead (10 entries) E2E", timings);
      expect(timings[0].ms).toBeLessThan(10000);
    });

    it("profiles entries.markRead with 50 entries", async () => {
      const ctx = createAuthContext(testUserId);
      const caller = createCaller(ctx);

      const entryIds = testEntryIds.slice(500, 550);
      const { timing } = await timeAsync("markRead(50) TOTAL", () =>
        caller.entries.markRead({
          entries: entryIds.map((id) => ({ id })),
          read: true,
          fromList: true,
        })
      );

      printTimings("entries.markRead (50 entries) E2E", [timing]);
      expect(timing.ms).toBeLessThan(10000);
    });
  });

  // ============================================================================
  // Decomposed step-by-step profiling of setStarred
  // ============================================================================

  describe("Decomposed setStarred profiling", () => {
    it("profiles each step of setStarred independently", async () => {
      const entryId = testEntryIds[600];
      const timings: Timing[] = [];

      // Step 1: UPDATE user_entries
      const { timing: t1 } = await timeAsync("1. UPDATE user_entries", () =>
        db.execute(sql`
          UPDATE user_entries
          SET starred = true, starred_changed_at = now(), updated_at = now(), has_starred = true
          WHERE user_id = ${testUserId} AND entry_id = ${entryId}
            AND starred_changed_at <= now()
        `)
      );
      timings.push(t1);

      // Step 2: SELECT from visible_entries (get final state)
      const { timing: t2 } = await timeAsync("2. SELECT visible_entries (1 entry)", () =>
        db.execute(sql`
          SELECT id, read, starred, updated_at, score, has_marked_read_on_list,
                 has_marked_unread, has_starred, type
          FROM visible_entries
          WHERE user_id = ${testUserId} AND id = ${entryId}
        `)
      );
      timings.push(t2);

      // Step 3a: Global counts (the expensive query)
      const { timing: t3a, result: globalResult } = await timeAsync(
        "3a. getEntryRelatedCounts: global scan",
        () =>
          db.execute(sql`
          SELECT
            count(*)::int as all_total,
            count(*) FILTER (WHERE NOT read)::int as all_unread,
            count(*) FILTER (WHERE starred)::int as starred_total,
            count(*) FILTER (WHERE starred AND NOT read)::int as starred_unread,
            count(*) FILTER (WHERE type = 'saved')::int as saved_total,
            count(*) FILTER (WHERE type = 'saved' AND NOT read)::int as saved_unread,
            MAX(CASE WHEN id = ${entryId} THEN subscription_id::text END) as entry_sub_id,
            MAX(CASE WHEN id = ${entryId} THEN type::text END) as entry_type
          FROM visible_entries
          WHERE user_id = ${testUserId}
        `)
      );
      timings.push(t3a);

      // Extract subscription ID from the result
      const row = (globalResult.rows[0] as Record<string, string>) ?? {};
      const subscriptionId = row.entry_sub_id;

      // Step 3b: Subscription count
      if (subscriptionId) {
        const { timing: t3b } = await timeAsync(
          "3b. getEntryRelatedCounts: subscription count",
          () =>
            db.execute(sql`
            SELECT count(*) FILTER (WHERE NOT read)::int as unread
            FROM visible_entries
            WHERE user_id = ${testUserId} AND subscription_id = ${subscriptionId}
          `)
        );
        timings.push(t3b);
      }

      // Step 3c: Tag count
      if (subscriptionId) {
        const { timing: t3c } = await timeAsync("3c. getEntryRelatedCounts: tag counts", () =>
          db.execute(sql`
            SELECT st.tag_id, count(*) FILTER (WHERE NOT ve.read)::int as unread
            FROM subscription_tags st
            INNER JOIN visible_entries ve ON ve.subscription_id = st.subscription_id
            WHERE ve.user_id = ${testUserId}
              AND st.tag_id IN (
                SELECT st2.tag_id FROM subscription_tags st2
                WHERE st2.subscription_id = ${subscriptionId}
              )
            GROUP BY st.tag_id
          `)
        );
        timings.push(t3c);
      }

      // Step 4: Redis publish (simulated - just measure the call overhead)
      const { timing: t4 } = await timeAsync("4. Redis publish (overhead)", async () => {
        // The actual publish is fire-and-forget, but let's measure import + call overhead
        const { publishEntryStateChanged } = await import("../../src/server/redis/pubsub");
        await publishEntryStateChanged(testUserId, entryId, false, true, new Date()).catch(
          () => {}
        );
      });
      timings.push(t4);

      printTimings("Decomposed setStarred", timings);

      // Highlight the bottleneck
      const sorted = [...timings].sort((a, b) => b.ms - a.ms);
      console.log(`\n  BOTTLENECK: "${sorted[0].label}" at ${sorted[0].ms.toFixed(1)}ms`);
      if (sorted.length > 1) {
        console.log(`  2nd slowest: "${sorted[1].label}" at ${sorted[1].ms.toFixed(1)}ms`);
      }

      expect(t1.ms).toBeLessThan(10000);
    });
  });

  // ============================================================================
  // Decomposed step-by-step profiling of markRead
  // ============================================================================

  describe("Decomposed markRead profiling", () => {
    it("profiles each step of markRead independently", async () => {
      const entryIds = testEntryIds.slice(700, 710);
      const timings: Timing[] = [];

      // Step 1: UPDATE user_entries (batch)
      const { timing: t1 } = await timeAsync("1. UPDATE user_entries (10 entries)", () =>
        db.execute(sql`
          UPDATE user_entries
          SET read = true, read_changed_at = now(), updated_at = now(), has_marked_read_on_list = true
          WHERE user_id = ${testUserId} AND entry_id = ANY(${sqlUuidArray(entryIds)})
            AND read_changed_at <= now()
        `)
      );
      timings.push(t1);

      // Step 2: SELECT from visible_entries (get final state for all entries)
      const { timing: t2, result: entriesResult } = await timeAsync(
        "2. SELECT visible_entries (10 entries)",
        () =>
          db.execute(sql`
          SELECT id, subscription_id, read, starred, type, updated_at, score,
                 has_marked_read_on_list, has_marked_unread, has_starred
          FROM visible_entries
          WHERE user_id = ${testUserId} AND id = ANY(${sqlUuidArray(entryIds)})
        `)
      );
      timings.push(t2);

      // Step 3a: Global counts
      const { timing: t3a } = await timeAsync("3a. getBulkCounts: global scan", () =>
        db.execute(sql`
          SELECT
            count(*)::int as all_total,
            count(*) FILTER (WHERE NOT read)::int as all_unread,
            count(*) FILTER (WHERE starred)::int as starred_total,
            count(*) FILTER (WHERE starred AND NOT read)::int as starred_unread,
            count(*) FILTER (WHERE type = 'saved')::int as saved_total,
            count(*) FILTER (WHERE type = 'saved' AND NOT read)::int as saved_unread
          FROM visible_entries
          WHERE user_id = ${testUserId}
        `)
      );
      timings.push(t3a);

      // Get unique subscription IDs from the entries
      const subIds = [
        ...new Set(
          entriesResult.rows
            .map((r: Record<string, unknown>) => r.subscription_id as string)
            .filter(Boolean)
        ),
      ];

      // Step 3b: Per-subscription counts
      if (subIds.length > 0) {
        const { timing: t3b } = await timeAsync(
          `3b. getBulkCounts: per-subscription counts (${subIds.length} subs)`,
          () =>
            db.execute(sql`
            SELECT subscription_id, count(*) FILTER (WHERE NOT read)::int as unread
            FROM visible_entries
            WHERE user_id = ${testUserId} AND subscription_id = ANY(${sqlUuidArray(subIds)})
            GROUP BY subscription_id
          `)
        );
        timings.push(t3b);
      }

      // Step 3c: Tag lookups
      if (subIds.length > 0) {
        const { timing: t3c } = await timeAsync("3c. getBulkCounts: tag lookups", () =>
          db.execute(sql`
            SELECT subscription_id, tag_id
            FROM subscription_tags
            WHERE subscription_id = ANY(${sqlUuidArray(subIds)})
          `)
        );
        timings.push(t3c);
      }

      // Step 3d: Tag unread counts
      const { timing: t3d } = await timeAsync("3d. getBulkCounts: tag unread counts", () =>
        db.execute(sql`
          SELECT st.tag_id, count(*) FILTER (WHERE NOT ve.read)::int as unread
          FROM subscription_tags st
          INNER JOIN visible_entries ve ON ve.subscription_id = st.subscription_id
          WHERE ve.user_id = ${testUserId}
            AND st.tag_id IN (
              SELECT st2.tag_id FROM subscription_tags st2
              WHERE st2.subscription_id = ANY(${sqlUuidArray(subIds)})
            )
          GROUP BY st.tag_id
        `)
      );
      timings.push(t3d);

      // Step 3e: Uncategorized count
      const { timing: t3e } = await timeAsync("3e. getBulkCounts: uncategorized count", () =>
        db.execute(sql`
          SELECT count(*) FILTER (WHERE NOT ve.read)::int as unread
          FROM visible_entries ve
          INNER JOIN user_feeds uf ON uf.id = ve.subscription_id
          WHERE ve.user_id = ${testUserId}
            AND NOT EXISTS (
              SELECT 1 FROM subscription_tags st
              WHERE st.subscription_id = uf.id
            )
        `)
      );
      timings.push(t3e);

      printTimings("Decomposed markRead (10 entries)", timings);

      const sorted = [...timings].sort((a, b) => b.ms - a.ms);
      console.log(`\n  BOTTLENECK: "${sorted[0].label}" at ${sorted[0].ms.toFixed(1)}ms`);
      if (sorted.length > 1) {
        console.log(`  2nd slowest: "${sorted[1].label}" at ${sorted[1].ms.toFixed(1)}ms`);
      }
      if (sorted.length > 2) {
        console.log(`  3rd slowest: "${sorted[2].label}" at ${sorted[2].ms.toFixed(1)}ms`);
      }

      expect(t1.ms).toBeLessThan(10000);
    });
  });

  // ============================================================================
  // Index utilization check
  // ============================================================================

  describe("Index utilization", () => {
    it("checks if partial indexes are being used for count queries", async () => {
      // Query that SHOULD use idx_user_entries_unread partial index
      const unreadPlan = await db.execute(sql`
        EXPLAIN (ANALYZE, FORMAT TEXT)
        SELECT count(*)::int
        FROM user_entries
        WHERE user_id = ${testUserId} AND read = false
      `);

      console.log("\n=== Unread count (should use idx_user_entries_unread) ===");
      for (const row of unreadPlan.rows) {
        console.log("  " + (row as Record<string, string>)["QUERY PLAN"]);
      }

      // Query that SHOULD use idx_user_entries_starred partial index
      const starredPlan = await db.execute(sql`
        EXPLAIN (ANALYZE, FORMAT TEXT)
        SELECT count(*)::int
        FROM user_entries
        WHERE user_id = ${testUserId} AND starred = true
      `);

      console.log("\n=== Starred count (should use idx_user_entries_starred) ===");
      for (const row of starredPlan.rows) {
        console.log("  " + (row as Record<string, string>)["QUERY PLAN"]);
      }

      // The view-based global count - does it use indexes?
      const viewPlan = await db.execute(sql`
        EXPLAIN (ANALYZE, FORMAT TEXT)
        SELECT count(*)::int
        FROM visible_entries
        WHERE user_id = ${testUserId}
      `);

      console.log("\n=== Global count via visible_entries (likely no index) ===");
      for (const row of viewPlan.rows) {
        console.log("  " + (row as Record<string, string>)["QUERY PLAN"]);
      }

      expect(unreadPlan.rows.length).toBeGreaterThan(0);
    });
  });
});
