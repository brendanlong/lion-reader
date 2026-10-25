/**
 * Integration tests for the database-backed business gauges.
 *
 * `metricsEnabled` is read from the environment at module load (and the db
 * module imports the metrics module), so METRICS_ENABLED is set in a hoisted
 * block before any import. No other file runs against this worker's database
 * at the same time, so gauge deltas around a test's own inserts are stable.
 */
import { describe, it, expect, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/server/db";
import { feeds } from "../../src/server/db/schema";
import { collectAllMetrics } from "../../src/server/metrics/collect";
import { registry } from "../../src/server/metrics/metrics";
import { createTestFeed } from "./helpers";

vi.hoisted(() => {
  process.env.METRICS_ENABLED = "true";
});

const feedIds: string[] = [];

afterAll(async () => {
  if (feedIds.length > 0) await db.delete(feeds).where(inArray(feeds.id, feedIds));
});

async function readGauge(name: string): Promise<number> {
  await collectAllMetrics(true);
  const metric = registry.getSingleMetric(name);
  const value = (await metric?.get())?.values[0]?.value;
  if (value === undefined) throw new Error(`gauge ${name} was not exported`);
  return value;
}

describe("feeds_total", () => {
  it("counts feeds", async () => {
    const before = await readGauge("feeds_total");

    feedIds.push(await createTestFeed());

    expect(await readGauge("feeds_total")).toBe(before + 1);
  });
});
