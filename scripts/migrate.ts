/**
 * Migration script that runs database migrations and clears Redis cache.
 *
 * Usage: pnpm db:migrate
 *
 * This script:
 * 1. Runs migrations using our custom runner (each migration in its own transaction)
 * 2. Flushes all Redis caches to ensure cached data is consistent with new schema
 * 3. In test mode (NODE_ENV=test), dumps the schema to drizzle/schema.sql
 */

import Redis from "ioredis";

import { dumpSchema } from "./dump-schema";
import { runMigrations } from "./run-migrations";

async function runDatabaseMigrations(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL environment variable is not set");
  }

  await runMigrations(databaseUrl);
}

async function flushRedisCache(): Promise<void> {
  const redisUrl = process.env.REDIS_URL;

  if (!redisUrl) {
    console.log("REDIS_URL not set, skipping cache flush");
    return;
  }

  console.log("Flushing Redis cache...");

  const redis = new Redis(redisUrl, {
    lazyConnect: true,
    maxRetriesPerRequest: 3,
  });

  try {
    await redis.connect();
    await redis.flushdb();
    console.log("Redis cache flushed successfully");
  } finally {
    await redis.quit();
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;

  try {
    await runDatabaseMigrations();
    await flushRedisCache();

    // Dump schema after test migrations so it can be checked into version control
    if (process.env.NODE_ENV === "test" && databaseUrl) {
      dumpSchema(databaseUrl);
    }

    console.log("\nMigration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

main();
