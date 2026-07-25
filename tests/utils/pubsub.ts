/**
 * Helpers for asserting on the Redis pub/sub events our services publish.
 *
 * All SSE publishing is deliberately fire-and-forget (issue #1082): a service
 * call's `await` resolves before its PUBLISH reaches Redis. Any test that
 * mutates state during setup and *then* subscribes is therefore racing its own
 * setup event — if the publish lands after the SUBSCRIBE, the setup event is
 * indistinguishable from one the action under test produced (issue #1427).
 * Use `subscribeAndDrain` for that setup instead of a bare `subscribe`.
 */

import { expect } from "vitest";
import type Redis from "ioredis";

/**
 * Resolves with the first `count` messages on `channel`. Always removes its own
 * listener (on match or timeout) so listeners don't accumulate on the shared
 * subscriber.
 */
export function waitForMessages(
  subscriber: Redis,
  channel: string,
  count: number,
  timeoutMs = 5000
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const messages: string[] = [];
    const listener = (ch: string, message: string) => {
      if (ch !== channel) return;
      messages.push(message);
      if (messages.length < count) return;
      cleanup();
      resolve(messages);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for ${count} message(s) on ${channel} (received ${messages.length})`
        )
      );
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      subscriber.off("message", listener);
    };
    subscriber.on("message", listener);
  });
}

/** Resolves with the first message on `channel`. */
export async function waitForMessage(
  subscriber: Redis,
  channel: string,
  timeoutMs = 5000
): Promise<string> {
  const [message] = await waitForMessages(subscriber, channel, 1, timeoutMs);
  return message;
}

/**
 * Subscribes to `channel`, runs a `setup` mutation expected to publish
 * `expectedEvents` events, and returns only once all of them have arrived — so
 * a late fire-and-forget publish from setup can't be mistaken for an event from
 * the action the test is actually asserting on (issue #1427).
 */
export async function subscribeAndDrain(
  subscriber: Redis,
  channel: string,
  setup: () => Promise<unknown>,
  expectedEvents = 1
): Promise<void> {
  await subscriber.subscribe(channel);
  const drained = waitForMessages(subscriber, channel, expectedEvents);
  await setup();
  await drained;
}

/** Runs `action`, then waits `quietMs` and asserts no message arrived on `channel`. */
export async function expectNoMessage(
  subscriber: Redis,
  channel: string,
  action: () => Promise<unknown>,
  quietMs = 200
): Promise<void> {
  let received = false;
  const listener = (ch: string) => {
    if (ch === channel) received = true;
  };
  subscriber.on("message", listener);
  try {
    await action();
    await new Promise((resolve) => setTimeout(resolve, quietMs));
    expect(received).toBe(false);
  } finally {
    subscriber.off("message", listener);
  }
}
