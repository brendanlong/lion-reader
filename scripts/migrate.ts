/**
 * Migration script that runs database migrations and clears Redis cache.
 *
 * Usage: pnpm db:migrate
 *
 * This script:
 * 1. Runs drizzle-kit migrate to apply pending database migrations
 * 2. Flushes all Redis caches to ensure cached data is consistent with new schema
 */

import { spawn } from "child_process";

import Redis from "ioredis";

async function runDrizzleMigrate(): Promise<void> {
  return new Promise((resolve, reject) => {
    console.log("Running database migrations...");

    const child = spawn("pnpm", ["drizzle-kit", "migrate"], {
      stdio: "inherit",
      shell: true,
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`drizzle-kit migrate exited with code ${code}`));
      }
    });

    child.on("error", (err) => {
      reject(err);
    });
  });
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
  try {
    await runDrizzleMigrate();
    await flushRedisCache();
    console.log("\nMigration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

main();
