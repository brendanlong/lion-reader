/**
 * The Redis token-bucket script, against a real Redis. The pure bucket logic is
 * unit-tested; this covers the Lua copy of it, which is what production runs,
 * and the speech procedure's character charge.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { TRPCError } from "@trpc/server";
import { checkRateLimit, RATE_LIMIT_CONFIGS } from "../../src/server/rate-limit";
import { createCaller } from "../../src/server/trpc/root";
import { generateUuidv7 } from "../../src/lib/uuidv7";
import { createAuthContext, createTestUser } from "./helpers";

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

describe("narration.synthesize rate limit", () => {
  // Without a key synthesis fails right after the charge, so nothing paid runs.
  const previousServerKey = process.env.OPENROUTER_API_KEY;
  beforeAll(() => {
    delete process.env.OPENROUTER_API_KEY;
  });
  afterAll(() => {
    if (previousServerKey !== undefined) process.env.OPENROUTER_API_KEY = previousServerKey;
  });

  const remaining = async (userId: string) => {
    const bucket = await redis.hget(`rate_limit:speech:user:${userId}`, "tokens");
    return Number(bucket);
  };

  it("charges the text length, with a floor for short texts", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    const { capacity } = RATE_LIMIT_CONFIGS.speech;

    await expect(
      caller.narration.synthesize({ model: null, voice: null, text: "Hi." })
    ).rejects.toThrow("OpenRouter API key");
    expect(await remaining(userId)).toBeCloseTo(capacity - 200, -2);

    const long = "word ".repeat(180);
    const before = await remaining(userId);
    await expect(
      caller.narration.synthesize({ model: null, voice: null, text: long })
    ).rejects.toThrow("OpenRouter API key");
    expect(before - (await remaining(userId))).toBeGreaterThan(long.length - 50);
  });

  it("rejects with TOO_MANY_REQUESTS once the characters run out", async () => {
    const userId = await createTestUser();
    const caller = createCaller(await createAuthContext(userId));
    await checkRateLimit(`user:${userId}`, "speech", {
      cost: RATE_LIMIT_CONFIGS.speech.capacity,
    });

    const error = await caller.narration
      .synthesize({ model: null, voice: null, text: "Hello." })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TRPCError);
    expect((error as TRPCError).code).toBe("TOO_MANY_REQUESTS");
    const cause = (error as TRPCError).cause as unknown as { headers: Record<string, string> };
    expect(Number(cause.headers["Retry-After"])).toBeGreaterThan(0);
  });
});
