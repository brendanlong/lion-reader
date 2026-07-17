import { describe, it, expect } from "vitest";
import {
  readResponseBufferWithSizeLimit,
  BodyReadTimeoutError,
  ContentTooLargeError,
} from "../../src/server/http/fetch";

/**
 * Minimal duck-typed stand-in for a `Response`/`Request`: the reader helpers
 * only touch `.headers.get()` and `.body.getReader()`.
 */
function bodyResponse(stream: ReadableStream<Uint8Array> | null): Response {
  return { headers: new Headers(), body: stream } as unknown as Response;
}

const enc = new TextEncoder();

describe("readResponseBufferWithSizeLimit", () => {
  it("returns the full body when it completes within limits", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("hello"));
        controller.close();
      },
    });
    const buf = await readResponseBufferWithSizeLimit(bodyResponse(stream), 1000, "test", 1000);
    expect(buf.toString()).toBe("hello");
  });

  it("returns an empty buffer when there is no body", async () => {
    const buf = await readResponseBufferWithSizeLimit(bodyResponse(null), 1000, "test");
    expect(buf.byteLength).toBe(0);
  });

  it("throws ContentTooLargeError when streamed bytes exceed the cap", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(enc.encode("toolong"));
        controller.close();
      },
    });
    await expect(
      readResponseBufferWithSizeLimit(bodyResponse(stream), 3, "test")
    ).rejects.toBeInstanceOf(ContentTooLargeError);
  });

  it("throws BodyReadTimeoutError when a trickling body never completes (slow-loris)", async () => {
    // A stream that enqueues nothing and never closes: read() would hang forever
    // without the wall-clock deadline.
    const stream = new ReadableStream<Uint8Array>({
      start() {
        /* never enqueue, never close */
      },
    });
    await expect(
      readResponseBufferWithSizeLimit(bodyResponse(stream), 1000, "test", 20)
    ).rejects.toBeInstanceOf(BodyReadTimeoutError);
  });

  it("does not time out a body that completes just under the deadline", async () => {
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        await new Promise((r) => setTimeout(r, 5));
        controller.enqueue(enc.encode("ok"));
        controller.close();
      },
    });
    const buf = await readResponseBufferWithSizeLimit(bodyResponse(stream), 1000, "test", 500);
    expect(buf.toString()).toBe("ok");
  });
});
