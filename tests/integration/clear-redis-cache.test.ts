/**
 * Integration test for the deploy-time Redis cache clear
 * (`clearRedisCacheExceptDurableKeys`). Runs against a real Redis.
 *
 * Regression coverage for "announcements / maintenance mode lost on deploy": the
 * migration step used to `flushdb()`, wiping the durable site-status keys along
 * with the cache. The clear must now delete everything **except** the durable
 * keys: site status and plan quota buckets.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import Redis from "ioredis";
import { clearRedisCacheExceptDurableKeys } from "../../src/server/redis/clear-cache";
import { MAINTENANCE_KEY, ANNOUNCEMENT_KEY } from "../../src/server/services/site-status-keys";
import { planQuotaKey } from "../../src/server/services/plan-quota-keys";

let redis: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL must be set for clear-redis-cache integration tests");
  }
  redis = new Redis(redisUrl);
});

afterAll(async () => {
  await redis.flushdb();
  await redis.quit();
});

beforeEach(async () => {
  await redis.flushdb();
});

// The exact `deleted` counts asserted below hold because the test keyspace is
// quiescent (no concurrent writers): SCAN can only re-list keys under concurrent
// rehashing, and UNLINK's actual-delete count is robust to that anyway.
describe("clearRedisCacheExceptDurableKeys", () => {
  it("preserves site-status keys and plan quota buckets and deletes everything else", async () => {
    // Durable source-of-truth flags that must survive a deploy.
    await redis.set(MAINTENANCE_KEY, JSON.stringify({ enabled: true, message: "brb" }));
    await redis.set(
      ANNOUNCEMENT_KEY,
      JSON.stringify({ enabled: true, message: "hello", level: "info" })
    );

    // A plan quota's allowance spans a day, so a deploy mustn't refill it.
    const quotaKey = planQuotaKey("pageFetches", "user-1");
    await redis.hset(quotaKey, "tokens", "3", "last_refill_ms", "1");

    // A spread of cache / ephemeral keys the deploy is meant to clear.
    await redis.set("session:v2:abc", "cached-session");
    await redis.set("user:123:events", "1");
    await redis.set("discord:token:456", "tok");
    await redis.set("some-random-cache-key", "x");

    const result = await clearRedisCacheExceptDurableKeys(redis);

    expect(result.deleted).toBe(4);
    expect(result.preserved).toBeGreaterThanOrEqual(3);
    expect(await redis.hget(quotaKey, "tokens")).toBe("3");

    // Site-status keys still there, with their exact values.
    expect(await redis.get(MAINTENANCE_KEY)).toBe(
      JSON.stringify({ enabled: true, message: "brb" })
    );
    expect(await redis.get(ANNOUNCEMENT_KEY)).toBe(
      JSON.stringify({ enabled: true, message: "hello", level: "info" })
    );

    // Everything else is gone.
    expect(await redis.get("session:v2:abc")).toBeNull();
    expect(await redis.get("user:123:events")).toBeNull();
    expect(await redis.get("discord:token:456")).toBeNull();
    expect(await redis.get("some-random-cache-key")).toBeNull();
  });

  it("is a no-op safe when only site-status keys exist", async () => {
    await redis.set(MAINTENANCE_KEY, JSON.stringify({ enabled: false, message: "" }));

    const result = await clearRedisCacheExceptDurableKeys(redis);

    expect(result.deleted).toBe(0);
    expect(await redis.get(MAINTENANCE_KEY)).toBe(JSON.stringify({ enabled: false, message: "" }));
  });

  it("handles an empty DB", async () => {
    const result = await clearRedisCacheExceptDurableKeys(redis);
    expect(result).toEqual({ deleted: 0, preserved: 0 });
  });

  it("clears a large key set across multiple SCAN batches", async () => {
    await redis.set(
      ANNOUNCEMENT_KEY,
      JSON.stringify({ enabled: true, message: "keep", level: "info" })
    );

    const pipeline = redis.pipeline();
    for (let i = 0; i < 1500; i++) {
      pipeline.set(`cache:key:${i}`, "v");
    }
    await pipeline.exec();

    const result = await clearRedisCacheExceptDurableKeys(redis);

    expect(result.deleted).toBe(1500);
    expect(await redis.get(ANNOUNCEMENT_KEY)).toBe(
      JSON.stringify({ enabled: true, message: "keep", level: "info" })
    );
    // Nothing but the preserved key remains.
    expect(await redis.dbsize()).toBe(1);
  });
});
