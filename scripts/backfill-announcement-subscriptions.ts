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
import { eq, sql } from "drizzle-orm";
import { Pool } from "pg";

import * as schema from "../src/server/db/schema";
import { announcementFeedConfig } from "../src/server/config/env";
import { createSubscription } from "../src/server/services/subscriptions";

const ANNOUNCEMENT_FEED_URL = announcementFeedConfig.url;
const BATCH_CONCURRENCY = 10;

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
    return;
  }

  console.log(`Backfilling announcement feed subscriptions for: ${ANNOUNCEMENT_FEED_URL}`);

  // Find users who have never had a subscription to the announcement feed
  // (no active subscription AND no unsubscribed record). This query runs
  // entirely in the database to avoid loading all user IDs into memory.
  const feedSubquery = db
    .select({ id: schema.feeds.id })
    .from(schema.feeds)
    .where(eq(schema.feeds.url, ANNOUNCEMENT_FEED_URL))
    .limit(1);

  const usersToSubscribe = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      sql`NOT EXISTS (
        SELECT 1 FROM ${schema.subscriptions}
        INNER JOIN ${schema.subscriptionFeeds}
          ON ${schema.subscriptionFeeds.subscriptionId} = ${schema.subscriptions.id}
        WHERE ${schema.subscriptions.userId} = ${schema.users.id}
          AND ${schema.subscriptionFeeds.feedId} IN (${feedSubquery})
      )`
    );

  console.log(`Found ${usersToSubscribe.length} users to subscribe`);

  let succeeded = 0;
  let failed = 0;

  // Process in parallel batches for performance
  for (let i = 0; i < usersToSubscribe.length; i += BATCH_CONCURRENCY) {
    const batch = usersToSubscribe.slice(i, i + BATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((user) =>
        createSubscription(db as typeof import("../src/server/db").db, user.id, {
          url: ANNOUNCEMENT_FEED_URL,
        })
      )
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled") {
        succeeded++;
      } else {
        failed++;
        console.error(`  Failed for user ${batch[j].id}:`, result.reason);
      }
    }

    if ((i + BATCH_CONCURRENCY) % 100 < BATCH_CONCURRENCY) {
      console.log(
        `  Progress: ${Math.min(i + BATCH_CONCURRENCY, usersToSubscribe.length)}/${usersToSubscribe.length}`
      );
    }
  }

  console.log(`Done! Succeeded: ${succeeded}, Failed: ${failed}`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exit(1);
  })
  .finally(() => pool.end());
