/**
 * Integration tests for the database-backed business gauges.
 *
 * `metricsEnabled` is read from the environment at module load (and the db
 * module imports the metrics module), so METRICS_ENABLED is set in a hoisted
 * block before any import. Integration files run serially, so gauge deltas
 * around a test's own inserts are stable.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds, users } from "../../src/server/db/schema";
import { collectAllMetrics } from "../../src/server/metrics/collect";
import { registry } from "../../src/server/metrics/metrics";
import { createTestFeed, createTestUser } from "./helpers";

vi.hoisted(() => {
  process.env.METRICS_ENABLED = "true";
});

const userIds: string[] = [];
const feedIds: string[] = [];

afterAll(async () => {
  if (feedIds.length > 0) await db.delete(feeds).where(inArray(feeds.id, feedIds));
  if (userIds.length > 0) await db.delete(users).where(inArray(users.id, userIds));
});

async function readGauge(name: string): Promise<number> {
  await collectAllMetrics(true);
  const metric = registry.getSingleMetric(name);
  const value = (await metric?.get())?.values[0]?.value;
  if (value === undefined) throw new Error(`gauge ${name} was not exported`);
  return value;
}

describe("feeds_total", () => {
  it("counts only web feeds, not per-user saved/email feeds", async () => {
    const before = await readGauge("feeds_total");

    const userId = await createTestUser({ emailPrefix: "metrics" });
    userIds.push(userId);
    for (const type of ["saved", "email"] as const) {
      feedIds.push(await createTestFeed({ type, userId, url: null }));
    }
    feedIds.push(await createTestFeed());

    expect(await readGauge("feeds_total")).toBe(before + 1);
  });
});
