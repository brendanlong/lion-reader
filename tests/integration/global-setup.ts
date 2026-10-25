/**
 * Gives each integration worker its own copy of the migrated test database and
 * its own Redis logical DB, so files can run in parallel even though they clean
 * up with table-wide deletes and `flushdb()`.
 */
import Redis from "ioredis";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  interface ProvidedContext {
    /** Indexed by `VITEST_POOL_ID - 1`. */
    workerServices: { databaseUrl: string; redisUrl: string }[];
  }
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for integration tests`);
  return value;
}

function databaseName(url: string): string {
  return pg.escapeIdentifier(decodeURIComponent(new URL(url).pathname.slice(1)));
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const baseDatabaseUrl = requireEnv("DATABASE_URL");
  const baseRedisUrl = requireEnv("REDIS_URL");
  const workers = project.config.maxWorkers;

  const services = Array.from({ length: workers }, (_, i) => {
    const databaseUrl = new URL(baseDatabaseUrl);
    databaseUrl.pathname = `${databaseUrl.pathname}_${i + 1}`;
    // Logical DB 0 stays the dev default.
    const redisUrl = new URL(baseRedisUrl);
    redisUrl.pathname = `/${i + 1}`;
    return { databaseUrl: databaseUrl.toString(), redisUrl: redisUrl.toString() };
  });

  const redis = new Redis(baseRedisUrl);
  try {
    const [, databases] = (await redis.config("GET", "databases")) as [string, string];
    if (workers >= Number(databases)) {
      throw new Error(
        `Integration tests need a Redis logical DB per worker: ${workers} workers, but Redis has ${databases} DBs (0 is left unused)`
      );
    }
  } finally {
    await redis.quit();
  }

  // CREATE DATABASE fails while anything is connected to the template, so this
  // connects to the maintenance database and copies one at a time.
  const adminUrl = new URL(baseDatabaseUrl);
  adminUrl.pathname = "/postgres";
  const template = databaseName(baseDatabaseUrl);
  const copies = services.map(({ databaseUrl }) => databaseName(databaseUrl));
  const withAdmin = async (run: (admin: pg.Client) => Promise<void>) => {
    const admin = new pg.Client({ connectionString: adminUrl.toString() });
    await admin.connect();
    try {
      await run(admin);
    } finally {
      await admin.end();
    }
  };
  const dropCopies = () =>
    withAdmin(async (admin) => {
      for (const copy of copies) {
        await admin.query(`DROP DATABASE IF EXISTS ${copy} WITH (FORCE)`);
      }
    });

  await dropCopies();
  await withAdmin(async (admin) => {
    for (const copy of copies) {
      await admin.query(`CREATE DATABASE ${copy} TEMPLATE ${template}`);
    }
  });

  project.provide("workerServices", services);
  return dropCopies;
}
