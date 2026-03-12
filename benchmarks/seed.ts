/**
 * Database seeder for benchmarks.
 *
 * Creates a realistic dataset:
 * - 3 users (1 benchmark user with real argon2 password, 2 others)
 * - 500 feeds (shared pool)
 * - 200 entries/feed = 100,000 total entries
 * - Each user subscribed to 300-400 feeds (~60-80K entries per user)
 * - 50% entries read, 5% starred
 * - 5 tags per user, feeds distributed across tags
 * - Realistic content_cleaned (200-500 chars)
 *
 * Pattern follows tests/integration/entries-perf.test.ts bulk insert approach.
 */

import { sql } from "drizzle-orm";
import * as argon2 from "argon2";
import { db } from "../src/server/db";
import {
  users,
  subscriptions,
  subscriptionFeeds,
  tags,
  subscriptionTags,
} from "../src/server/db/schema";
import { generateUuidv7 } from "../src/lib/uuidv7";

// ============================================================================
// Configuration
// ============================================================================

const NUM_FEEDS = 500;
const ENTRIES_PER_FEED = 200;
const NUM_TAGS = 5;

/** Benchmark user gets 400 feeds, others get 300 each */
const BENCHMARK_USER_FEEDS = 400;
const OTHER_USER_FEEDS = 300;

export const BENCHMARK_USER_EMAIL = "benchmark@test.com";
export const BENCHMARK_USER_PASSWORD = "benchmark-password-123";

function pgUuidArray(ids: string[]) {
  return `{${ids.join(",")}}`;
}

// ============================================================================
// Seeder
// ============================================================================

export async function seed(): Promise<{ userId: string }> {
  const startTime = performance.now();
  console.log("Starting benchmark data seeding...");
  console.log(
    `  ${NUM_FEEDS} feeds x ${ENTRIES_PER_FEED} entries = ${(NUM_FEEDS * ENTRIES_PER_FEED).toLocaleString()} total entries`
  );

  // Clean existing benchmark data
  await db.execute(sql`
    DELETE FROM users WHERE email LIKE 'benchmark%@test.com'
  `);

  // Step 1: Create users
  const passwordHash = await argon2.hash(BENCHMARK_USER_PASSWORD);
  const userIds: string[] = [];
  const userEmails = [BENCHMARK_USER_EMAIL, "benchmark-2@test.com", "benchmark-3@test.com"];

  for (let i = 0; i < 3; i++) {
    const id = generateUuidv7();
    userIds.push(id);
  }

  await db.insert(users).values(
    userIds.map((id, i) => ({
      id,
      email: userEmails[i],
      passwordHash: i === 0 ? passwordHash : "not-a-real-hash",
      tosAgreedAt: new Date(),
      privacyPolicyAgreedAt: new Date(),
      notEuAgreedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    }))
  );

  const benchmarkUserId = userIds[0];
  console.log(`  Users created: 3 (${elapsed(startTime)})`);

  // Step 2: Create tags per user
  const tagIdsByUser = new Map<string, string[]>();
  const allTagValues: {
    id: string;
    userId: string;
    name: string;
    createdAt: Date;
    updatedAt: Date;
  }[] = [];

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
  console.log(`  Tags created: ${allTagValues.length} (${elapsed(startTime)})`);

  // Step 3: Create feeds
  const feedsStart = performance.now();
  await db.execute(sql`
    INSERT INTO feeds (id, type, url, title, last_fetched_at, last_entries_updated_at, created_at, updated_at)
    SELECT
      gen_random_uuid(),
      'web',
      'https://bench-' || i || '.example.com/feed.xml',
      'Benchmark Feed ' || i,
      now(),
      now(),
      now(),
      now()
    FROM generate_series(1, ${NUM_FEEDS}) AS i
  `);
  console.log(`  Feeds created: ${NUM_FEEDS} (${elapsed(feedsStart)})`);

  // Fetch feed IDs
  const feedRows = await db.execute(sql`
    SELECT id FROM feeds WHERE url LIKE 'https://bench-%' ORDER BY url
  `);
  const allFeedIds = feedRows.rows.map((r: Record<string, unknown>) => r.id as string);

  // Step 4: Create subscriptions
  const subsStart = performance.now();
  const feedCounts = [BENCHMARK_USER_FEEDS, OTHER_USER_FEEDS, OTHER_USER_FEEDS];

  for (let u = 0; u < 3; u++) {
    const userId = userIds[u];
    const count = feedCounts[u];
    // Offset feeds so there's some overlap between users
    const offset = u === 0 ? 0 : (u - 1) * 100;
    const userFeedIds = allFeedIds.slice(offset, offset + count);

    const CHUNK = 500;
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
  console.log(`  Subscriptions created (${elapsed(subsStart)})`);

  // Step 5: Assign tags
  const tagsStart = performance.now();
  for (let u = 0; u < 3; u++) {
    const userId = userIds[u];
    const userTags = tagIdsByUser.get(userId)!;

    const subRows = await db.execute(sql`
      SELECT id FROM subscriptions
      WHERE user_id = ${userId} AND unsubscribed_at IS NULL
      ORDER BY id
    `);
    const userSubIds = subRows.rows.map((r: Record<string, unknown>) => r.id as string);

    // Leave ~10% uncategorized
    const taggedCount = Math.floor(userSubIds.length * 0.9);
    const stValues: { subscriptionId: string; tagId: string }[] = [];
    for (let i = 0; i < taggedCount; i++) {
      stValues.push({
        subscriptionId: userSubIds[i],
        tagId: userTags[i % NUM_TAGS],
      });
    }

    const CHUNK = 1000;
    for (let c = 0; c < stValues.length; c += CHUNK) {
      await db.insert(subscriptionTags).values(stValues.slice(c, c + CHUNK));
    }
  }
  console.log(`  Tags assigned (${elapsed(tagsStart)})`);

  // Step 6: Create entries
  const entriesStart = performance.now();
  const FEED_BATCH = 100;
  for (let b = 0; b < NUM_FEEDS; b += FEED_BATCH) {
    const batchEnd = Math.min(b + FEED_BATCH, NUM_FEEDS);
    const batchFeedIds = allFeedIds.slice(b, batchEnd);

    await db.execute(sql`
      INSERT INTO entries (id, feed_id, type, guid, title, content_cleaned, content_hash,
                          fetched_at, published_at, last_seen_at, created_at, updated_at)
      SELECT
        gen_random_uuid(),
        f.feed_id,
        'web',
        f.feed_id || '-' || e.i,
        'Entry ' || e.i || ' about ' || CASE (e.i % 5)
          WHEN 0 THEN 'technology and innovation'
          WHEN 1 THEN 'science and research'
          WHEN 2 THEN 'business strategy'
          WHEN 3 THEN 'product development'
          ELSE 'industry analysis'
        END,
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. ' ||
        'Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ' ||
        CASE (e.i % 3)
          WHEN 0 THEN 'Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. '
          WHEN 1 THEN 'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt mollit anim id est laborum. '
          ELSE 'Curabitur pretium tincidunt lacus. Nulla gravida orci a odio. Nullam varius, turpis et commodo pharetra. '
        END,
        f.feed_id || '-' || e.i,
        now() - ((${ENTRIES_PER_FEED} - e.i) || ' minutes')::interval,
        now() - ((${ENTRIES_PER_FEED} - e.i) || ' minutes')::interval,
        now(),
        now(),
        now()
      FROM unnest(${pgUuidArray(batchFeedIds)}::uuid[]) AS f(feed_id)
      CROSS JOIN generate_series(1, ${ENTRIES_PER_FEED}) AS e(i)
    `);

    const progress = batchEnd * ENTRIES_PER_FEED;
    const total = NUM_FEEDS * ENTRIES_PER_FEED;
    console.log(
      `  Entries: ${progress.toLocaleString()} / ${total.toLocaleString()} (${elapsed(entriesStart)})`
    );
  }

  // Step 7: Create user_entries
  const ueStart = performance.now();
  for (let u = 0; u < 3; u++) {
    const userId = userIds[u];
    const count = feedCounts[u];
    const offset = u === 0 ? 0 : (u - 1) * 100;
    const userFeedIds = allFeedIds.slice(offset, offset + count);

    const FEED_BATCH_UE = 50;
    for (let b = 0; b < userFeedIds.length; b += FEED_BATCH_UE) {
      const batchFeedIds = userFeedIds.slice(b, b + FEED_BATCH_UE);

      await db.execute(sql`
        INSERT INTO user_entries (user_id, entry_id, read, starred, read_changed_at, starred_changed_at, updated_at)
        SELECT
          ${userId}::uuid,
          e.id,
          (row_number() OVER (PARTITION BY e.feed_id ORDER BY e.id)) <= ${ENTRIES_PER_FEED / 2},
          (row_number() OVER (PARTITION BY e.feed_id ORDER BY e.id)) % 20 = 0,
          e.published_at,
          e.published_at,
          now()
        FROM entries e
        WHERE e.feed_id = ANY(${pgUuidArray(batchFeedIds)}::uuid[])
      `);
    }
    console.log(`  user_entries: user ${u + 1}/3 (${elapsed(ueStart)})`);
  }

  // Step 8: ANALYZE
  const analyzeStart = performance.now();
  await db.execute(sql`ANALYZE entries`);
  await db.execute(sql`ANALYZE user_entries`);
  await db.execute(sql`ANALYZE feeds`);
  await db.execute(sql`ANALYZE subscriptions`);
  await db.execute(sql`ANALYZE subscription_feeds`);
  await db.execute(sql`ANALYZE subscription_tags`);
  await db.execute(sql`ANALYZE tags`);
  console.log(`  ANALYZE complete (${elapsed(analyzeStart)})`);

  const totalTime = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`\nSeeding complete in ${totalTime}s`);

  return { userId: benchmarkUserId };
}

function elapsed(start: number): string {
  return `${((performance.now() - start) / 1000).toFixed(1)}s`;
}

// Run directly
if (process.argv[1]?.endsWith("seed.ts")) {
  seed()
    .then(({ userId }) => {
      console.log(`Benchmark user ID: ${userId}`);
      process.exit(0);
    })
    .catch((err) => {
      console.error("Seeding failed:", err);
      process.exit(1);
    });
}
