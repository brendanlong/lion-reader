/**
 * Migration script that runs database migrations and clears Redis cache.
 *
 * Usage: pnpm db:migrate
 *
 * This script:
 * 1. Runs migrations using our custom runner (each migration in its own transaction)
 * 2. Clears cached Redis data so it can't go stale against the new schema —
 *    preserving the durable site-status flags (announcement + maintenance mode),
 *    which are the source of truth and must survive a deploy.
 */

import Redis from "ioredis";

import { runMigrations } from "./run-migrations";
import { clearRedisCacheExceptSiteStatus } from "@/server/redis/clear-cache";

async function runDatabaseMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  await runMigrations(databaseUrl);
}

async function clearRedisCache(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    console.log("REDIS_URL not set, skipping cache clear");
    return;
  }

  console.log("Clearing Redis cache (preserving site-status keys)...");

  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  try {
    await redis.connect();
    const { deleted, preserved } = await clearRedisCacheExceptSiteStatus(redis);
    console.log(
      `Redis cache cleared: deleted ${deleted} key(s), preserved ${preserved} site-status key(s)`
    );
  } finally {
    await redis.quit();
  }
}

async function main() {
  try {
    await runDatabaseMigrations();
    await clearRedisCache();

    console.log("\nMigration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

main();
