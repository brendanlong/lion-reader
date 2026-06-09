/**
 * Integration tests for the shared Redis pub/sub subscriber (#874).
 *
 * Verifies that createPubSubSubscription multiplexes all channel
 * subscriptions in the process over a single shared Redis connection:
 * in-process fan-out to multiple handles, per-channel filtering, and
 * reference-counted Redis-level SUBSCRIBE/UNSUBSCRIBE.
 *
 * Uses a real Redis via docker-compose.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Redis from "ioredis";
import { createPubSubSubscription } from "../../src/server/redis/pubsub";
import { generateUuidv7 } from "../../src/lib/uuidv7";

// Raw Redis client for publishing and inspecting subscription counts,
// independent of the shared subscriber under test.
let redis: Redis;

beforeAll(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL must be set for integration tests");
  }
  redis = new Redis(redisUrl);
});

afterAll(async () => {
  await redis.quit();
});

function uniqueChannel(): string {
  return `test:${generateUuidv7()}:events`;
}

/** Number of Redis-level subscribers on a channel (counts connections, not listeners). */
async function numsub(channel: string): Promise<number> {
  const result = (await redis.call("pubsub", "numsub", channel)) as [string, number | string];
  return Number(result[1]);
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for condition");
}

/** Collects received messages for assertion. */
function collector(): {
  messages: Array<{ channel: string; message: string }>;
  listener: (channel: string, message: string) => void;
} {
  const messages: Array<{ channel: string; message: string }> = [];
  return {
    messages,
    listener: (channel, message) => {
      messages.push({ channel, message });
    },
  };
}

describe("createPubSubSubscription", () => {
  it("delivers published messages to a subscribed handle", async () => {
    const channel = uniqueChannel();
    const received = collector();
    const handle = createPubSubSubscription(received.listener);
    expect(handle).not.toBeNull();

    try {
      await handle!.subscribe(channel);
      expect(await numsub(channel)).toBe(1);

      await redis.publish(channel, "hello");
      await waitFor(() => received.messages.length === 1);
      expect(received.messages[0]).toEqual({ channel, message: "hello" });
    } finally {
      handle!.close();
    }
  });

  it("fans out one Redis-level subscription to multiple handles", async () => {
    const channel = uniqueChannel();
    const receivedA = collector();
    const receivedB = collector();
    const handleA = createPubSubSubscription(receivedA.listener);
    const handleB = createPubSubSubscription(receivedB.listener);

    try {
      await Promise.all([handleA!.subscribe(channel), handleB!.subscribe(channel)]);

      // Both handles share a single connection-level subscription
      expect(await numsub(channel)).toBe(1);

      await redis.publish(channel, "fan-out");
      await waitFor(() => receivedA.messages.length === 1 && receivedB.messages.length === 1);
      expect(receivedA.messages[0]).toEqual({ channel, message: "fan-out" });
      expect(receivedB.messages[0]).toEqual({ channel, message: "fan-out" });
    } finally {
      handleA!.close();
      handleB!.close();
    }
  });

  it("only delivers messages for channels the handle subscribed to", async () => {
    const channelA = uniqueChannel();
    const channelB = uniqueChannel();
    const receivedA = collector();
    const receivedB = collector();
    const handleA = createPubSubSubscription(receivedA.listener);
    const handleB = createPubSubSubscription(receivedB.listener);

    try {
      await Promise.all([handleA!.subscribe(channelA), handleB!.subscribe(channelB)]);

      await redis.publish(channelA, "for-a");
      await waitFor(() => receivedA.messages.length === 1);

      expect(receivedA.messages).toEqual([{ channel: channelA, message: "for-a" }]);
      expect(receivedB.messages).toEqual([]);
    } finally {
      handleA!.close();
      handleB!.close();
    }
  });

  it("keeps the channel subscribed until the last handle releases it", async () => {
    const channel = uniqueChannel();
    const receivedA = collector();
    const receivedB = collector();
    const handleA = createPubSubSubscription(receivedA.listener);
    const handleB = createPubSubSubscription(receivedB.listener);

    await Promise.all([handleA!.subscribe(channel), handleB!.subscribe(channel)]);

    // Closing one handle must not tear down the shared channel subscription
    handleA!.close();
    expect(await numsub(channel)).toBe(1);

    await redis.publish(channel, "after-close");
    await waitFor(() => receivedB.messages.length === 1);
    expect(receivedB.messages[0]).toEqual({ channel, message: "after-close" });
    expect(receivedA.messages).toEqual([]);

    // Closing the last handle unsubscribes at the Redis level
    handleB!.close();
    await waitFor(async () => (await numsub(channel)) === 0);
  });

  it("unsubscribes individual channels without affecting others", async () => {
    const channelA = uniqueChannel();
    const channelB = uniqueChannel();
    const received = collector();
    const handle = createPubSubSubscription(received.listener);

    try {
      await handle!.subscribe(channelA, channelB);
      expect(await numsub(channelA)).toBe(1);
      expect(await numsub(channelB)).toBe(1);

      handle!.unsubscribe(channelA);
      await waitFor(async () => (await numsub(channelA)) === 0);
      expect(await numsub(channelB)).toBe(1);

      await redis.publish(channelA, "dropped");
      await redis.publish(channelB, "kept");
      await waitFor(() => received.messages.length === 1);
      expect(received.messages).toEqual([{ channel: channelB, message: "kept" }]);
    } finally {
      handle!.close();
    }
  });

  it("ignores subscribe calls after close", async () => {
    const channel = uniqueChannel();
    const received = collector();
    const handle = createPubSubSubscription(received.listener);

    handle!.close();
    handle!.close(); // idempotent
    await handle!.subscribe(channel);
    expect(await numsub(channel)).toBe(0);
  });
});
