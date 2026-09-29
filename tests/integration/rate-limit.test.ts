/**
 * The Redis token-bucket script, against a real Redis. The pure bucket logic is
 * unit-tested; this covers the Lua copy of it, which is what production runs.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { checkRateLimit, RATE_LIMIT_CONFIGS } from "../../src/server/rate-limit";
import { generateUuidv7 } from "../../src/lib/uuidv7";

let redis: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL must be set for rate-limit integration tests");
  }
  redis = new Redis(redisUrl);
});

afterAll(async () => {
  await redis.quit();
});

describe("checkRateLimit", () => {
  it("counts the speech limit in characters", async () => {
    const user = `user:${generateUuidv7()}`;
    const { capacity } = RATE_LIMIT_CONFIGS.speech;

    // Many short chunks fit where a request count would have run out.
    for (let i = 0; i < 100; i++) {
      expect((await checkRateLimit(user, "speech", { cost: 20 })).allowed).toBe(true);
    }

    const result = await checkRateLimit(user, "speech", { cost: capacity });
    expect(result.allowed).toBe(false);
    expect(result.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("charges one token per request by default", async () => {
    const user = `user:${generateUuidv7()}`;
    const { capacity } = RATE_LIMIT_CONFIGS.expensive;
    for (let i = 0; i < capacity; i++) {
      expect((await checkRateLimit(user, "expensive")).allowed).toBe(true);
    }
    expect((await checkRateLimit(user, "expensive")).allowed).toBe(false);
  });
});
