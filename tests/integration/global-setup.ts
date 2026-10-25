import Redis from "ioredis";
import pg from "pg";
import type { TestProject } from "vitest/node";

import { workerDatabaseUrl } from "./worker-services";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} must be set for integration tests`);
  return value;
}

function databaseName(url: string): string {
  return pg.escapeIdentifier(decodeURIComponent(new URL(url).pathname.slice(1)));
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const baseUrl = requireEnv("DATABASE_URL");
  const workers = project.config.maxWorkers;

  const redis = new Redis(requireEnv("REDIS_URL"));
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
  const adminUrl = new URL(baseUrl);
  adminUrl.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const template = databaseName(baseUrl);
  const copies = Array.from({ length: workers }, (_, i) =>
    databaseName(workerDatabaseUrl(baseUrl, i + 1))
  );
  const dropCopies = async () => {
    for (const copy of copies) {
      await admin.query(`DROP DATABASE IF EXISTS ${copy} WITH (FORCE)`);
    }
  };
  await dropCopies();
  for (const copy of copies) {
    await admin.query(`CREATE DATABASE ${copy} TEMPLATE ${template}`);
  }

  return async () => {
    await dropCopies();
    await admin.end();
  };
}
