// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeImage } from "@/lib/image-decode";

/**
 * decodeImage warms the browser's decoded-image cache before we swap a fresh
 * <img> into view, resolving when the decode finishes or a timeout elapses —
 * whichever comes first. jsdom has no real image decoder (no `decode` method at
 * all), so we install a stub to model the cached (fast resolve), failed
 * (reject), and slow (never settles) cases.
 */

type DecodeFn = () => Promise<void>;

function stubDecode(fn: DecodeFn): void {
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    writable: true,
    value: fn,
  });
}

describe("decodeImage", () => {
  afterEach(() => {
    // Remove the stub so it never leaks between tests.
    delete (HTMLImageElement.prototype as unknown as { decode?: DecodeFn }).decode;
    vi.restoreAllMocks();
  });

  it("resolves once the image decodes (before the timeout)", async () => {
    stubDecode(() => Promise.resolve());

    // A generous timeout that we should never hit — decode wins.
    await expect(decodeImage("https://example.com/a.png", 1000)).resolves.toBeUndefined();
  });

  it("resolves (does not reject) when decode fails", async () => {
    stubDecode(() => Promise.reject(new Error("boom")));

    await expect(decodeImage("https://example.com/a.png", 1000)).resolves.toBeUndefined();
  });

  it("resolves on the timeout when decode never settles", async () => {
    vi.useFakeTimers();
    // A decode that never resolves — only the timeout can settle the promise.
    stubDecode(() => new Promise<void>(() => {}));

    const promise = decodeImage("https://example.com/a.png", 50);
    let settled = false;
    void promise.then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBeUndefined();

    vi.useRealTimers();
  });
});
