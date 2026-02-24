/**
 * Performance profiling for the entries.get endpoint.
 *
 * Measures each layer independently to identify bottlenecks:
 * - Raw SQL query (visible_entries view point lookup)
 * - Drizzle ORM overhead (query building + result mapping)
 * - Zod output validation
 * - SuperJSON serialization
 * - Full tRPC caller (middleware + all of the above)
 *
 * Run with: pnpm test:integration -- tests/integration/entries-get-profile.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { z } from "zod";
import superjson from "superjson";
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

function timeSync<T>(label: string, fn: () => T): { result: T; timing: Timing } {
  const start = performance.now();
  const result = fn();
  const ms = performance.now() - start;
  return { result, timing: { label, ms } };
}

// ============================================================================
// Test Data
// ============================================================================

let testUserId: string;
let testEntryId: string;
let testFeedId: string;

// Large content to simulate realistic article sizes
const SMALL_CONTENT = "Short article content.";
const LARGE_CONTENT = "Lorem ipsum dolor sit amet. ".repeat(2000); // ~56KB
const HUGE_CONTENT = "Lorem ipsum dolor sit amet. ".repeat(10000); // ~280KB

const entryIds: Record<string, string> = {};

async function cleanupTestData() {
  await db.delete(userEntries);
  await db.delete(entries);
  await db.delete(subscriptionFeeds);
  await db.delete(subscriptions);
  await db.delete(feeds);
  await db.delete(users);
}

// Zod schema matching the actual entryFullSchema from the router
const feedTypeSchema = z.enum(["web", "email", "saved"]);
const entryFullSchema = z.object({
  id: z.string(),
  subscriptionId: z.string().nullable(),
  feedId: z.string(),
  type: feedTypeSchema,
  url: z.string().nullable(),
  title: z.string().nullable(),
  author: z.string().nullable(),
  contentOriginal: z.string().nullable(),
  contentCleaned: z.string().nullable(),
  summary: z.string().nullable(),
  publishedAt: z.date().nullable(),
  fetchedAt: z.date(),
  read: z.boolean(),
  starred: z.boolean(),
  updatedAt: z.date(),
  feedTitle: z.string().nullable(),
  feedUrl: z.string().nullable(),
  siteName: z.string().nullable(),
  unsubscribeUrl: z.string().nullable(),
  fullContentOriginal: z.string().nullable(),
  fullContentCleaned: z.string().nullable(),
  fullContentFetchedAt: z.date().nullable(),
  fullContentError: z.string().nullable(),
  score: z.number().nullable(),
  implicitScore: z.number(),
  fetchFullContent: z.boolean(),
});
const outputSchema = z.object({ entry: entryFullSchema });

describe("entries.get Performance Profiling", () => {
  beforeAll(async () => {
    await cleanupTestData();

    // Create user
    testUserId = generateUuidv7();
    await db.insert(users).values({
      id: testUserId,
      email: `get-perf-${testUserId}@test.com`,
      passwordHash: "test-hash",
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create feed
    testFeedId = generateUuidv7();
    const now = new Date();
    await db.insert(feeds).values({
      id: testFeedId,
      type: "web",
      url: "https://perf-test.example.com/feed.xml",
      title: "Perf Test Feed",
      lastFetchedAt: now,
      lastEntriesUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    });

    // Create subscription
    const subId = generateUuidv7();
    await db.insert(subscriptions).values({
      id: subId,
      userId: testUserId,
      feedId: testFeedId,
      subscribedAt: new Date(Date.now() - 365 * 24 * 60 * 60 * 1000),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(subscriptionFeeds).values({
      subscriptionId: subId,
      feedId: testFeedId,
      userId: testUserId,
    });

    // Create entries with different content sizes
    const contentSizes: Record<string, string> = {
      small: SMALL_CONTENT,
      large: LARGE_CONTENT,
      huge: HUGE_CONTENT,
    };

    for (const [label, content] of Object.entries(contentSizes)) {
      const entryId = generateUuidv7();
      entryIds[label] = entryId;

      await db.insert(entries).values({
        id: entryId,
        feedId: testFeedId,
        type: "web",
        guid: `guid-${entryId}`,
        title: `Entry (${label} content)`,
        contentOriginal: content,
        contentCleaned: content,
        contentHash: `hash-${entryId}`,
        fetchedAt: now,
        publishedAt: now,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });

      await db.insert(userEntries).values({
        userId: testUserId,
        entryId,
        read: false,
        starred: false,
        readChangedAt: now,
        starredChangedAt: now,
        updatedAt: now,
      });
    }

    testEntryId = entryIds.small;

    // Also create 1000 additional entries to make the dataset realistic
    const bulkEntries = [];
    const bulkUserEntries = [];
    for (let i = 0; i < 1000; i++) {
      const eid = generateUuidv7();
      const t = new Date(Date.now() - i * 60000);
      bulkEntries.push({
        id: eid,
        feedId: testFeedId,
        type: "web" as const,
        guid: `guid-bulk-${eid}`,
        title: `Bulk Entry ${i}`,
        contentCleaned: `Bulk content ${i}`,
        contentHash: `hash-bulk-${eid}`,
        fetchedAt: t,
        publishedAt: t,
        lastSeenAt: now,
        createdAt: now,
        updatedAt: now,
      });
      bulkUserEntries.push({
        userId: testUserId,
        entryId: eid,
        read: i > 500,
        starred: i % 20 === 0,
        readChangedAt: t,
        starredChangedAt: t,
        updatedAt: now,
      });
    }
    await db.insert(entries).values(bulkEntries);
    await db.insert(userEntries).values(bulkUserEntries);

    console.log(`\nSetup: 1003 entries (3 test + 1000 bulk) for user ${testUserId}`);
  }, 60000);

  afterAll(async () => {
    await cleanupTestData();
  });

  // ============================================================================
  // Layer-by-layer profiling
  // ============================================================================

  describe("Layer-by-layer breakdown", () => {
    it("profiles each layer of entries.get independently", async () => {
      const timings: Timing[] = [];

      // --- Layer 1: Raw SQL point lookup through visible_entries view ---
      // This is the minimum possible DB time
      const { timing: tRawSql } = await timeAsync("1. Raw SQL (visible_entries point lookup)", () =>
        db.execute(sql`
          SELECT
            ve.id, ve.feed_id, ve.type, ve.url, ve.title, ve.author,
            ve.content_original, ve.content_cleaned, ve.summary,
            ve.published_at, ve.fetched_at, ve.read, ve.starred,
            ve.updated_at, ve.subscription_id, ve.site_name,
            f.title as feed_title, f.url as feed_url,
            ve.unsubscribe_url,
            ve.full_content_original, ve.full_content_cleaned,
            ve.full_content_fetched_at, ve.full_content_error,
            ve.score, ve.content_hash,
            ve.has_marked_read_on_list, ve.has_marked_unread, ve.has_starred,
            s.fetch_full_content
          FROM visible_entries ve
          INNER JOIN feeds f ON ve.feed_id = f.id
          LEFT JOIN subscriptions s ON ve.subscription_id = s.id
          WHERE ve.id = ${testEntryId} AND ve.user_id = ${testUserId}
          LIMIT 1
        `)
      );
      timings.push(tRawSql);

      // --- Layer 2: Drizzle ORM query (same query, through ORM) ---
      // Measures ORM overhead: query building, result mapping, type coercion
      const { timing: tDrizzle, result: drizzleResult } = await timeAsync(
        "2. Drizzle ORM query (selectFullEntry equivalent)",
        async () => {
          const { visibleEntries, feeds, subscriptions } =
            await import("../../src/server/db/schema");
          const { eq, and } = await import("drizzle-orm");

          return db
            .select({
              id: visibleEntries.id,
              feedId: visibleEntries.feedId,
              type: visibleEntries.type,
              url: visibleEntries.url,
              title: visibleEntries.title,
              author: visibleEntries.author,
              contentOriginal: visibleEntries.contentOriginal,
              contentCleaned: visibleEntries.contentCleaned,
              summary: visibleEntries.summary,
              publishedAt: visibleEntries.publishedAt,
              fetchedAt: visibleEntries.fetchedAt,
              read: visibleEntries.read,
              starred: visibleEntries.starred,
              updatedAt: visibleEntries.updatedAt,
              subscriptionId: visibleEntries.subscriptionId,
              siteName: visibleEntries.siteName,
              feedTitle: feeds.title,
              feedUrl: feeds.url,
              unsubscribeUrl: visibleEntries.unsubscribeUrl,
              fullContentOriginal: visibleEntries.fullContentOriginal,
              fullContentCleaned: visibleEntries.fullContentCleaned,
              fullContentFetchedAt: visibleEntries.fullContentFetchedAt,
              fullContentError: visibleEntries.fullContentError,
              score: visibleEntries.score,
              contentHash: visibleEntries.contentHash,
              hasMarkedReadOnList: visibleEntries.hasMarkedReadOnList,
              hasMarkedUnread: visibleEntries.hasMarkedUnread,
              hasStarred: visibleEntries.hasStarred,
              fetchFullContent: subscriptions.fetchFullContent,
            })
            .from(visibleEntries)
            .innerJoin(feeds, eq(visibleEntries.feedId, feeds.id))
            .leftJoin(subscriptions, eq(visibleEntries.subscriptionId, subscriptions.id))
            .where(and(eq(visibleEntries.id, testEntryId), eq(visibleEntries.userId, testUserId)))
            .limit(1);
        }
      );
      timings.push(tDrizzle);

      // --- Layer 3: toFullEntry transformation (in-memory) ---
      const row = drizzleResult[0];
      const { timing: tTransform, result: transformedEntry } = timeSync(
        "3. toFullEntry transform (in-memory)",
        () => {
          if (!row) throw new Error("No row");
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
          const { hasStarred, hasMarkedUnread, hasMarkedReadOnList, contentHash, ...rest } = row;
          return {
            ...rest,
            implicitScore: hasStarred ? 2 : hasMarkedUnread ? 0 : hasMarkedReadOnList ? -1 : 0,
            fetchFullContent: row.fetchFullContent ?? false,
          };
        }
      );
      timings.push(tTransform);

      // --- Layer 4: Zod output validation ---
      const outputData = { entry: transformedEntry };
      const { timing: tZod } = timeSync("4. Zod output validation", () => {
        outputSchema.parse(outputData);
      });
      timings.push(tZod);

      // --- Layer 5: SuperJSON serialization ---
      const { timing: tSuperjson } = timeSync("5. SuperJSON serialize", () => {
        superjson.serialize(outputData);
      });
      timings.push(tSuperjson);

      // --- Layer 6: SuperJSON deserialization (client side, for reference) ---
      const serialized = superjson.serialize(outputData);
      const { timing: tDeserialize } = timeSync("6. SuperJSON deserialize (client-side)", () => {
        superjson.deserialize(serialized);
      });
      timings.push(tDeserialize);

      printTimings("entries.get Layer Breakdown (small content)", timings);

      // All layers should complete
      expect(row).toBeDefined();
    });
  });

  // ============================================================================
  // Content size impact
  // ============================================================================

  describe("Content size impact", () => {
    it("compares entries.get across content sizes", async () => {
      const ctx = createAuthContext(testUserId);
      const caller = createCaller(ctx);

      for (const [label, entryId] of Object.entries(entryIds)) {
        const timings: Timing[] = [];

        // Warm up (first call may have cold-cache effects)
        await caller.entries.get({ id: entryId });

        // Measure 5 iterations
        for (let i = 0; i < 5; i++) {
          const { timing } = await timeAsync(`iteration ${i + 1}`, () =>
            caller.entries.get({ id: entryId })
          );
          timings.push(timing);
        }

        const times = timings.map((t) => t.ms).sort((a, b) => a - b);
        const avg = times.reduce((a, b) => a + b, 0) / times.length;
        const p50 = times[Math.floor(times.length / 2)];
        const min = times[0];
        const max = times[times.length - 1];

        console.log(
          `\n--- entries.get (${label} content) ---` +
            `\n  avg=${avg.toFixed(1)}ms  p50=${p50.toFixed(1)}ms  min=${min.toFixed(1)}ms  max=${max.toFixed(1)}ms`
        );

        expect(avg).toBeLessThan(5000);
      }
    });
  });

  // ============================================================================
  // Full tRPC caller vs raw query comparison
  // ============================================================================

  describe("tRPC caller overhead", () => {
    it("compares tRPC caller total vs raw SQL for the same entry", async () => {
      const ctx = createAuthContext(testUserId);
      const caller = createCaller(ctx);

      // Warm up both paths
      await caller.entries.get({ id: testEntryId });
      await db.execute(sql`
        SELECT ve.*, f.title as feed_title, f.url as feed_url, s.fetch_full_content
        FROM visible_entries ve
        INNER JOIN feeds f ON ve.feed_id = f.id
        LEFT JOIN subscriptions s ON ve.subscription_id = s.id
        WHERE ve.id = ${testEntryId} AND ve.user_id = ${testUserId}
        LIMIT 1
      `);

      const ITERATIONS = 20;
      const trpcTimes: number[] = [];
      const rawTimes: number[] = [];

      for (let i = 0; i < ITERATIONS; i++) {
        // tRPC caller (includes middleware, Zod, SuperJSON)
        const trpcStart = performance.now();
        await caller.entries.get({ id: testEntryId });
        trpcTimes.push(performance.now() - trpcStart);

        // Raw SQL (just the database)
        const rawStart = performance.now();
        await db.execute(sql`
          SELECT ve.*, f.title as feed_title, f.url as feed_url, s.fetch_full_content
          FROM visible_entries ve
          INNER JOIN feeds f ON ve.feed_id = f.id
          LEFT JOIN subscriptions s ON ve.subscription_id = s.id
          WHERE ve.id = ${testEntryId} AND ve.user_id = ${testUserId}
          LIMIT 1
        `);
        rawTimes.push(performance.now() - rawStart);
      }

      const stats = (times: number[]) => {
        const sorted = [...times].sort((a, b) => a - b);
        return {
          avg: sorted.reduce((a, b) => a + b, 0) / sorted.length,
          p50: sorted[Math.floor(sorted.length / 2)],
          p95: sorted[Math.floor(sorted.length * 0.95)],
          min: sorted[0],
          max: sorted[sorted.length - 1],
        };
      };

      const trpcStats = stats(trpcTimes);
      const rawStats = stats(rawTimes);
      const overhead = trpcStats.avg - rawStats.avg;

      console.log("\n=== tRPC Caller vs Raw SQL (20 iterations, small content) ===");
      console.log(
        `  tRPC:     avg=${trpcStats.avg.toFixed(1)}ms  p50=${trpcStats.p50.toFixed(1)}ms  p95=${trpcStats.p95.toFixed(1)}ms  min=${trpcStats.min.toFixed(1)}ms  max=${trpcStats.max.toFixed(1)}ms`
      );
      console.log(
        `  Raw SQL:  avg=${rawStats.avg.toFixed(1)}ms  p50=${rawStats.p50.toFixed(1)}ms  p95=${rawStats.p95.toFixed(1)}ms  min=${rawStats.min.toFixed(1)}ms  max=${rawStats.max.toFixed(1)}ms`
      );
      console.log(
        `  Overhead: ${overhead.toFixed(1)}ms (${((overhead / rawStats.avg) * 100).toFixed(0)}% of raw SQL time)`
      );

      expect(trpcStats.avg).toBeLessThan(5000);
    });
  });

  // ============================================================================
  // EXPLAIN ANALYZE for the actual query
  // ============================================================================

  describe("Query plan analysis", () => {
    it("shows EXPLAIN ANALYZE for the entries.get query", async () => {
      const result = await db.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT
          ve.id, ve.feed_id, ve.type, ve.url, ve.title, ve.author,
          ve.content_original, ve.content_cleaned, ve.summary,
          ve.published_at, ve.fetched_at, ve.read, ve.starred,
          ve.updated_at, ve.subscription_id, ve.site_name,
          f.title as feed_title, f.url as feed_url,
          ve.unsubscribe_url,
          ve.full_content_original, ve.full_content_cleaned,
          ve.full_content_fetched_at, ve.full_content_error,
          ve.score, ve.content_hash,
          ve.has_marked_read_on_list, ve.has_marked_unread, ve.has_starred,
          s.fetch_full_content
        FROM visible_entries ve
        INNER JOIN feeds f ON ve.feed_id = f.id
        LEFT JOIN subscriptions s ON ve.subscription_id = s.id
        WHERE ve.id = ${testEntryId} AND ve.user_id = ${testUserId}
        LIMIT 1
      `);

      console.log("\n=== EXPLAIN ANALYZE: entries.get query ===");
      for (const row of result.rows) {
        console.log("  " + (row as Record<string, string>)["QUERY PLAN"]);
      }

      expect(result.rows.length).toBeGreaterThan(0);
    });

    it("shows EXPLAIN ANALYZE for large content entry", async () => {
      const result = await db.execute(sql`
        EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT)
        SELECT
          ve.id, ve.feed_id, ve.type, ve.url, ve.title, ve.author,
          ve.content_original, ve.content_cleaned, ve.summary,
          ve.published_at, ve.fetched_at, ve.read, ve.starred,
          ve.updated_at, ve.subscription_id, ve.site_name,
          f.title as feed_title, f.url as feed_url,
          ve.unsubscribe_url,
          ve.full_content_original, ve.full_content_cleaned,
          ve.full_content_fetched_at, ve.full_content_error,
          ve.score, ve.content_hash,
          ve.has_marked_read_on_list, ve.has_marked_unread, ve.has_starred,
          s.fetch_full_content
        FROM visible_entries ve
        INNER JOIN feeds f ON ve.feed_id = f.id
        LEFT JOIN subscriptions s ON ve.subscription_id = s.id
        WHERE ve.id = ${entryIds.huge} AND ve.user_id = ${testUserId}
        LIMIT 1
      `);

      console.log("\n=== EXPLAIN ANALYZE: entries.get query (huge content ~280KB) ===");
      for (const row of result.rows) {
        console.log("  " + (row as Record<string, string>)["QUERY PLAN"]);
      }

      expect(result.rows.length).toBeGreaterThan(0);
    });
  });

  // ============================================================================
  // Zod validation cost in isolation
  // ============================================================================

  describe("Zod validation cost", () => {
    it("measures Zod output validation for different content sizes", async () => {
      const ctx = createAuthContext(testUserId);
      const caller = createCaller(ctx);

      for (const [label, entryId] of Object.entries(entryIds)) {
        // Get a real entry result to validate
        const result = await caller.entries.get({ id: entryId });

        const ITERATIONS = 1000;
        const start = performance.now();
        for (let i = 0; i < ITERATIONS; i++) {
          outputSchema.parse(result);
        }
        const totalMs = performance.now() - start;
        const perCall = totalMs / ITERATIONS;

        console.log(
          `  Zod validation (${label}): ${perCall.toFixed(3)}ms/call (${ITERATIONS} iterations, total ${totalMs.toFixed(1)}ms)`
        );
      }
    });

    it("measures SuperJSON serialization for different content sizes", async () => {
      const ctx = createAuthContext(testUserId);
      const caller = createCaller(ctx);

      for (const [label, entryId] of Object.entries(entryIds)) {
        const result = await caller.entries.get({ id: entryId });

        const ITERATIONS = 1000;
        const start = performance.now();
        for (let i = 0; i < ITERATIONS; i++) {
          superjson.serialize(result);
        }
        const totalMs = performance.now() - start;
        const perCall = totalMs / ITERATIONS;

        const serialized = superjson.serialize(result);
        const jsonSize = JSON.stringify(serialized).length;

        console.log(
          `  SuperJSON serialize (${label}): ${perCall.toFixed(3)}ms/call, payload=${(jsonSize / 1024).toFixed(1)}KB`
        );
      }
    });
  });
});
