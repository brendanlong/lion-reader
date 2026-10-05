/**
 * Drives the real `/api/v1/events` SSE route in integration tests: opens a
 * stream as a user, reads it in the background, and lets a test wait for the
 * events it expects.
 */

import { db } from "../../src/server/db";
import { createSession } from "../../src/server/auth/session";
import { GET as eventsGet } from "../../src/app/api/v1/events/route";

const DEFAULT_TIMEOUT_MS = 5000;
const POLL_MS = 20;

type SseData = Record<string, unknown>;

export interface SseStream {
  /** Everything received so far, raw. */
  readonly text: string;
  /** The parsed data of every complete event of `type` received so far. */
  events(type: string): SseData[];
  /** Resolves with the first event of `type` matching `predicate`, waiting for it. */
  waitFor(type: string, predicate?: (data: SseData) => boolean): Promise<SseData>;
  close(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Opens an SSE stream as `userId` (session cookie auth). Close it in a `finally`. */
export async function openSseStream(userId: string): Promise<SseStream> {
  const { token } = await createSession(db, { userId });
  const res = await eventsGet(
    new Request("http://localhost:3000/api/v1/events", {
      headers: { cookie: `session=${token}` },
    })
  );
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let ended = false;

  const pump = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
      }
    } catch {
      // Cancelled by close()
    } finally {
      ended = true;
    }
  })();

  function events(type: string): SseData[] {
    // The last block may be partial until its terminating blank line arrives.
    return text
      .split("\n\n")
      .slice(0, -1)
      .filter((block) => block.startsWith(`event: ${type}\n`))
      .map((block) => {
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        return JSON.parse(data!.slice("data: ".length)) as SseData;
      });
  }

  return {
    get text() {
      return text;
    },
    events,
    async waitFor(type, predicate = () => true) {
      const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
      for (;;) {
        const match = events(type).find(predicate);
        if (match) return match;
        if (ended) throw new Error(`SSE stream ended before a matching ${type}`);
        if (Date.now() > deadline) throw new Error(`Timed out waiting for ${type}`);
        await sleep(POLL_MS);
      }
    },
    async close() {
      await reader.cancel();
      await pump;
    },
  };
}

/**
 * Publishes repeatedly until `done()` holds. A stream subscribes to its
 * channels asynchronously after opening, so the first publishes can land
 * before it listens; republishing is the only way to know it is.
 */
export async function publishUntil(
  publish: () => Promise<unknown>,
  done: () => boolean
): Promise<void> {
  const deadline = Date.now() + DEFAULT_TIMEOUT_MS;
  while (!done()) {
    if (Date.now() > deadline) throw new Error("SSE stream never received the publish");
    await publish();
    await sleep(50);
  }
}
