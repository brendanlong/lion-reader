/**
 * Backfill script: subscribe existing users to the announcement feed.
 *
 * Usage: dotenv -- tsx scripts/backfill-announcement-subscriptions.ts
 *
 * This script subscribes all existing users to the announcement feed who:
 * - Don't already have an active subscription to it
 * - Haven't previously unsubscribed from it (respects soft deletes)
 *
 * Safe to run multiple times (idempotent for users who already have the subscription).
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { Pool } from "pg";

import * as schema from "../src/server/db/schema";
import { createSubscription } from "../src/server/services/subscriptions";

const ANNOUNCEMENT_FEED_URL =
  process.env.ANNOUNCEMENT_FEED_URL || "https://announcements.lionreader.com/feed.xml";

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  console.error("DATABASE_URL environment variable is not set");
  process.exit(1);
}

const pool = new Pool({ connectionString });
const db = drizzle(pool, { schema });

async function main() {
  if (!ANNOUNCEMENT_FEED_URL) {
    console.log("ANNOUNCEMENT_FEED_URL is empty, skipping backfill");
    process.exit(0);
  }

  console.log(`Backfilling announcement feed subscriptions for: ${ANNOUNCEMENT_FEED_URL}`);

  // Find the feed record (if it exists)
  const feedRecord = await db
    .select({ id: schema.feeds.id })
    .from(schema.feeds)
    .where(eq(schema.feeds.url, ANNOUNCEMENT_FEED_URL))
    .limit(1);

  // Get all user IDs
  const allUsers = await db.select({ id: schema.users.id }).from(schema.users);
  console.log(`Found ${allUsers.length} total users`);

  // If the feed already exists, find users who have ever had a subscription to it
  // (active or unsubscribed) so we can skip them
  const usersWithExistingSubscription = new Set<string>();
  if (feedRecord.length > 0) {
    const feedId = feedRecord[0].id;

    // Check subscriptions table directly — includes both active and unsubscribed
    const existing = await db
      .select({ userId: schema.subscriptions.userId })
      .from(schema.subscriptions)
      .innerJoin(
        schema.subscriptionFeeds,
        eq(schema.subscriptionFeeds.subscriptionId, schema.subscriptions.id)
      )
      .where(eq(schema.subscriptionFeeds.feedId, feedId));

    for (const row of existing) {
      usersWithExistingSubscription.add(row.userId);
    }
    console.log(
      `Found ${usersWithExistingSubscription.size} users with existing subscription (active or unsubscribed)`
    );
  }

  // Subscribe users who don't have any subscription record
  const usersToSubscribe = allUsers.filter((u) => !usersWithExistingSubscription.has(u.id));
  console.log(`Subscribing ${usersToSubscribe.length} users...`);

  let succeeded = 0;
  let failed = 0;

  for (const user of usersToSubscribe) {
    try {
      await createSubscription(db as typeof import("../src/server/db").db, user.id, {
        url: ANNOUNCEMENT_FEED_URL,
      });
      succeeded++;
      if (succeeded % 100 === 0) {
        console.log(`  Progress: ${succeeded}/${usersToSubscribe.length}`);
      }
    } catch (err) {
      failed++;
      console.error(`  Failed for user ${user.id}:`, err);
    }
  }

  console.log(`Done! Succeeded: ${succeeded}, Failed: ${failed}`);
  await pool.end();
}

main().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
