/**
 * Performance profiling tests for entries.markRead and entries.setStarred endpoints.
 *
 * These tests create realistic data volumes and time each phase of the mutation
 * to identify bottlenecks (UPDATE, visibleEntries SELECT, count queries, Redis pub/sub).
 *
 * Skipped by default because setup takes ~10 minutes to insert 10M rows.
 * Run with: RUN_PERF_TESTS=1 pnpm test:integration -- tests/integration/entries-perf.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import {
  users,
  subscriptions,
  subscriptionFeeds,
  userEntries,
  tags,
  subscriptionTags,
} from "../../src/server/db/schema";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createCaller } from "../../src/server/trpc/root";
import type { Context } from "../../src/server/trpc/context";

/** Format a JS string array as a PostgreSQL array literal for parameterized queries */
function pgUuidArray(ids: string[]) {
  return `{${ids.join(",")}}`;
}

// ============================================================================
// Configuration
// ============================================================================

/** Total number of feeds (shared across users) */
const NUM_FEEDS = 10_000;

/** Number of entries per feed */
const ENTRIES_PER_FEED = 1_000;

/** Total entries: NUM_FEEDS * ENTRIES_PER_FEED = 10,000,000 */

/** Number of users */
const NUM_USERS = 20;

/** Feeds per user (each user subscribes to a distinct set) */
const FEEDS_PER_USER = NUM_FEEDS / NUM_USERS; // 500

/** Entries per user: FEEDS_PER_USER * ENTRIES_PER_FEED = 500,000 */

/** Number of tags per user */
const NUM_TAGS = 5;

/** Feeds left uncategorized per user (no tags assigned) */
const UNCATEGORIZED_FEEDS_PER_USER = 50;

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
    const pct = total > 0 ? ((t.ms / total) * 100).toFixed(1) : "0.0";
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

/** The primary user we run most profiling queries against */
let testUserId: string;
/** Sample entry IDs for the test user (fetched after bulk insert) */
let testEntryIds: string[] = [];
/** Subscription IDs for the test user (fetched after bulk insert) */
let testSubscriptionIds: string[] = [];
/** Tag IDs for the test user (fetched after bulk insert) */
let testTagIds: string[] = [];

async function cleanupTestData() {
  // Use TRUNCATE for speed on large tables
  await db.execute(sql`TRUNCATE subscription_tags, tags, user_entries, entries,
    subscription_feeds, subscriptions, feeds, users CASCADE`);
}

describe.skipIf(!process.env.RUN_PERF_TESTS)("Entries Performance Profiling", () => {
  beforeAll(async () => {
    await cleanupTestData();

    console.log("\n--- Setting up test data ---");
    console.log(
      `  ${NUM_FEEDS} feeds × ${ENTRIES_PER_FEED} entries = ${(NUM_FEEDS * ENTRIES_PER_FEED).toLocaleString()} total entries`
    );
    console.log(
      `  ${NUM_USERS} users × ${FEEDS_PER_USER} feeds = ${(FEEDS_PER_USER * ENTRIES_PER_FEED).toLocaleString()} entries per user`
    );
    const setupStart = performance.now();

    // Step 1: Create users (small, use JS)
    const userIds: string[] = [];
    for (let i = 0; i < NUM_USERS; i++) {
      userIds.push(generateUuidv7());
    }
    testUserId = userIds[0];

    await db.insert(users).values(
      userIds.map((id) => ({
        id,
        email: `perf-test-${id}@test.com`,
        passwordHash: "test-hash",
        createdAt: new Date(),
        updatedAt: new Date(),
      }))
    );
    console.log(
      `  Users created: ${userIds.length} (${(performance.now() - setupStart).toFixed(0)}ms)`
    );

    // Step 2: Create tags for each user (small, use JS)
    const allTagValues: {
      id: string;
      userId: string;
      name: string;
      createdAt: Date;
      updatedAt: Date;
    }[] = [];
    const tagIdsByUser = new Map<string, string[]>();
    for (const userId of userIds) {
      const userTagIds: string[] = [];
      for (let t = 0; t < NUM_TAGS; t++) {
        const tagId = generateUuidv7();
        userTagIds.push(tagId);
        allTagValues.push({
          id: tagId,
          userId,
          name: `Tag ${t}`,
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      tagIdsByUser.set(userId, userTagIds);
    }
    await db.insert(tags).values(allTagValues);
    testTagIds = tagIdsByUser.get(testUserId)!;
    console.log(
      `  Tags created: ${allTagValues.length} (${(performance.now() - setupStart).toFixed(0)}ms)`
    );

    // Step 3: Bulk-create feeds using generate_series (10,000 feeds)
    const feedsStart = performance.now();
    await db.execute(sql`
      INSERT INTO feeds (id, type, url, title, last_fetched_at, last_entries_updated_at, created_at, updated_at)
      SELECT
        gen_random_uuid(),
        'web',
        'https://perf-test-' || i || '.example.com/feed.xml',
        'Perf Feed ' || i,
        now(),
        now(),
        now(),
        now()
      FROM generate_series(1, ${NUM_FEEDS}) AS i
    `);
    console.log(`  Feeds created: ${NUM_FEEDS} (${(performance.now() - feedsStart).toFixed(0)}ms)`);

    // Step 4: Fetch feed IDs ordered so we can partition them across users
    const feedRows = await db.execute(sql`
      SELECT id FROM feeds ORDER BY url
    `);
    const allFeedIds = feedRows.rows.map((r: Record<string, unknown>) => r.id as string);

    // Step 5: Create subscriptions + subscription_feeds for each user
    // Each user gets FEEDS_PER_USER distinct feeds
    const subsStart = performance.now();
    for (let u = 0; u < NUM_USERS; u++) {
      const userId = userIds[u];
      const userFeedIds = allFeedIds.slice(u * FEEDS_PER_USER, (u + 1) * FEEDS_PER_USER);

      // Build subscription + subscription_feeds values in chunks
      const CHUNK = 1000;
      for (let c = 0; c < userFeedIds.length; c += CHUNK) {
        const chunk = userFeedIds.slice(c, c + CHUNK);
        const subValues = chunk.map((feedId) => ({
          id: generateUuidv7(),
          userId,
          feedId,
          subscribedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
          createdAt: new Date(),
          updatedAt: new Date(),
        }));
        await db.insert(subscriptions).values(subValues);

        const sfValues = subValues.map((s) => ({
          subscriptionId: s.id,
          feedId: s.feedId,
          userId,
        }));
        await db.insert(subscriptionFeeds).values(sfValues);
      }
    }
    console.log(
      `  Subscriptions created: ${NUM_FEEDS} (${(performance.now() - subsStart).toFixed(0)}ms)`
    );

    // Step 6: Assign tags to subscriptions (leave some uncategorized)
    const tagsStart = performance.now();
    for (let u = 0; u < NUM_USERS; u++) {
      const userId = userIds[u];
      const userTags = tagIdsByUser.get(userId)!;

      // Fetch this user's subscription IDs
      const subRows = await db.execute(sql`
        SELECT id FROM subscriptions
        WHERE user_id = ${userId} AND unsubscribed_at IS NULL
        ORDER BY id
      `);
      const userSubIds = subRows.rows.map((r: Record<string, unknown>) => r.id as string);

      // Assign tags to all but the last UNCATEGORIZED_FEEDS_PER_USER subscriptions
      const taggedCount = userSubIds.length - UNCATEGORIZED_FEEDS_PER_USER;
      const stValues: { subscriptionId: string; tagId: string }[] = [];
      for (let i = 0; i < taggedCount; i++) {
        stValues.push({
          subscriptionId: userSubIds[i],
          tagId: userTags[i % NUM_TAGS],
        });
      }

      // Insert in chunks
      const CHUNK = 2000;
      for (let c = 0; c < stValues.length; c += CHUNK) {
        await db.insert(subscriptionTags).values(stValues.slice(c, c + CHUNK));
      }
    }
    console.log(`  Subscription tags assigned (${(performance.now() - tagsStart).toFixed(0)}ms)`);

    // Step 7: Bulk-create entries using generate_series
    // This is the big one: 10M rows. Do it in feed-batches using SQL.
    const entriesStart = performance.now();
    const FEED_BATCH = 500; // Create entries for 500 feeds at a time
    for (let b = 0; b < NUM_FEEDS; b += FEED_BATCH) {
      const batchEnd = Math.min(b + FEED_BATCH, NUM_FEEDS);
      const batchFeedIds = allFeedIds.slice(b, batchEnd);

      // Use unnest + generate_series cross join for maximum insert speed
      await db.execute(sql`
        INSERT INTO entries (id, feed_id, type, guid, title, content_cleaned, content_hash,
                            fetched_at, published_at, last_seen_at, created_at, updated_at)
        SELECT
          gen_random_uuid(),
          f.feed_id,
          'web',
          f.feed_id || '-' || e.i,
          'Entry ' || e.i,
          'Test content for entry ' || e.i || ' in feed.',
          f.feed_id || '-' || e.i,
          now() - ((${ENTRIES_PER_FEED} - e.i) || ' minutes')::interval,
          now() - ((${ENTRIES_PER_FEED} - e.i) || ' minutes')::interval,
          now(),
          now(),
          now()
        FROM unnest(${pgUuidArray(batchFeedIds)}::uuid[]) AS f(feed_id)
        CROSS JOIN generate_series(1, ${ENTRIES_PER_FEED}) AS e(i)
      `);

      const entriesInserted = batchEnd * ENTRIES_PER_FEED;
      const elapsed = ((performance.now() - entriesStart) / 1000).toFixed(1);
      console.log(
        `  Entries: ${entriesInserted.toLocaleString()} / ${(NUM_FEEDS * ENTRIES_PER_FEED).toLocaleString()} (${elapsed}s)`
      );
    }
    console.log(
      `  Entries created: ${(NUM_FEEDS * ENTRIES_PER_FEED).toLocaleString()} (${((performance.now() - entriesStart) / 1000).toFixed(1)}s)`
    );

    // Step 8: Create user_entries for each user
    // Each user needs entries for their FEEDS_PER_USER feeds
    const ueStart = performance.now();
    for (let u = 0; u < NUM_USERS; u++) {
      const userId = userIds[u];
      const userFeedIds = allFeedIds.slice(u * FEEDS_PER_USER, (u + 1) * FEEDS_PER_USER);

      // Insert in feed-batches
      const FEED_BATCH_UE = 100;
      for (let b = 0; b < userFeedIds.length; b += FEED_BATCH_UE) {
        const batchFeedIds = userFeedIds.slice(b, b + FEED_BATCH_UE);

        await db.execute(sql`
          INSERT INTO user_entries (user_id, entry_id, read, starred, read_changed_at, starred_changed_at, updated_at)
          SELECT
            ${userId}::uuid,
            e.id,
            (row_number() OVER (PARTITION BY e.feed_id ORDER BY e.id)) <= ${ENTRIES_PER_FEED / 2},
            (row_number() OVER (PARTITION BY e.feed_id ORDER BY e.id)) % 10 = 0,
            e.published_at,
            e.published_at,
            now()
          FROM entries e
          WHERE e.feed_id = ANY(${pgUuidArray(batchFeedIds)}::uuid[])
        `);
      }

      const ueInserted = (u + 1) * FEEDS_PER_USER * ENTRIES_PER_FEED;
      const elapsed = ((performance.now() - ueStart) / 1000).toFixed(1);
      console.log(
        `  user_entries: user ${u + 1}/${NUM_USERS} — ${ueInserted.toLocaleString()} / ${(NUM_FEEDS * ENTRIES_PER_FEED).toLocaleString()} (${elapsed}s)`
      );
    }
    console.log(`  user_entries created (${((performance.now() - ueStart) / 1000).toFixed(1)}s)`);

    // Step 9: Fetch sample IDs for the test user
    const sampleRows = await db.execute(sql`
      SELECT ue.entry_id as id
      FROM user_entries ue
      WHERE ue.user_id = ${testUserId}
      ORDER BY ue.entry_id
      LIMIT 1000
    `);
    testEntryIds = sampleRows.rows.map((r: Record<string, unknown>) => r.id as string);

    const subRows = await db.execute(sql`
      SELECT id FROM subscriptions
      WHERE user_id = ${testUserId} AND unsubscribed_at IS NULL
      ORDER BY id
    `);
    testSubscriptionIds = subRows.rows.map((r: Record<string, unknown>) => r.id as string);

    // Step 10: ANALYZE tables for accurate query plans
    const analyzeStart = performance.now();
    await db.execute(sql`ANALYZE entries`);
    await db.execute(sql`ANALYZE user_entries`);
    await db.execute(sql`ANALYZE feeds`);
    await db.execute(sql`ANALYZE subscriptions`);
    await db.execute(sql`ANALYZE subscription_feeds`);
    await db.execute(sql`ANALYZE subscription_tags`);
    await db.execute(sql`ANALYZE tags`);
    console.log(`  ANALYZE complete (${(performance.now() - analyzeStart).toFixed(0)}ms)`);

    const setupMs = performance.now() - setupStart;
    console.log(`\nSetup complete in ${(setupMs / 1000).toFixed(1)}s`);

    // Print table sizes
    const sizeResult = await db.execute(sql`
      SELECT
        relname AS table_name,
        n_live_tup AS rows,
        pg_size_pretty(pg_total_relation_size(relid)) AS total_size
      FROM pg_stat_user_tables
      WHERE schemaname = 'public'
      ORDER BY pg_total_relation_size(relid) DESC
      LIMIT 10
    `);
    console.log("\nTable sizes:");
    for (const row of sizeResult.rows) {
      const r = row as Record<string, unknown>;
      console.log(
        `  ${String(r.table_name).padEnd(25)} ${String(r.rows).padStart(12)} rows  ${r.total_size}`
      );
    }

    // Print per-user entry count
    const [countRow] = await db
      .execute(
        sql`
      SELECT count(*)::int as cnt FROM user_entries WHERE user_id = ${testUserId}
    `
      )
      .then((r) => r.rows as { cnt: number }[]);
    console.log(`\nTest user entry count: ${countRow.cnt.toLocaleString()}`);
  }, 3600000); // 1 hour timeout for setup

  afterAll(async () => {
    await cleanupTestData();
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
          WHERE ve.user_id = ${testUserId} AND ve.id = ANY(${pgUuidArray(tenIds)}::uuid[])
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
      expect(t1.ms).toBeLessThan(60000);
    }, 300000);

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
    }, 300000);

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
    }, 300000);

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
    }, 300000);

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
      expect(t1.ms).toBeLessThan(60000);
    }, 300000);
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

      expect(tTotal.ms).toBeLessThan(120000);
    }, 600000);

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

      expect(times[0]).toBeLessThan(120000);
    }, 600000);

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
      expect(timings[0].ms).toBeLessThan(120000);
    }, 600000);

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
      expect(timing.ms).toBeLessThan(120000);
    }, 600000);
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

      expect(t1.ms).toBeLessThan(120000);
    }, 600000);
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
          WHERE user_id = ${testUserId} AND entry_id = ANY(${pgUuidArray(entryIds)}::uuid[])
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
          WHERE user_id = ${testUserId} AND id = ANY(${pgUuidArray(entryIds)}::uuid[])
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
            WHERE user_id = ${testUserId} AND subscription_id = ANY(${pgUuidArray(subIds)}::uuid[])
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
            WHERE subscription_id = ANY(${pgUuidArray(subIds)}::uuid[])
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
              WHERE st2.subscription_id = ANY(${pgUuidArray(subIds)}::uuid[])
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

      expect(t1.ms).toBeLessThan(120000);
    }, 600000);
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
    }, 300000);
  });
});
