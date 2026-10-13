/**
 * @vitest-environment jsdom
 */

/**
 * Unit tests for buffering errors raised before the lazy Sentry SDK loads.
 */

import { describe, it, expect, vi } from "vitest";
import { bufferEarlyErrors } from "@/lib/sentry/early-errors";

// A stand-in for `window`: vitest fails the run on error events dispatched there.
const target = new EventTarget();

function fireError(error: unknown): void {
  target.dispatchEvent(new ErrorEvent("error", { error, message: "Script error." }));
}

function fireRejection(reason: unknown): void {
  target.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason }));
}

describe("bufferEarlyErrors", () => {
  it("reports each early error once, as unhandled, when the SDK loads", () => {
    const buffer = bufferEarlyErrors(target);
    const error = new Error("boom");
    const reason = new Error("rejected");
    fireError(error);
    fireRejection(reason);

    const reporter = { captureException: vi.fn() };
    buffer.flush(reporter);

    expect(reporter.captureException.mock.calls).toEqual([
      [error, { mechanism: { type: "onerror", handled: false } }],
      [reason, { mechanism: { type: "onunhandledrejection", handled: false } }],
    ]);
  });

  it("ignores error events with no error (cross-origin 'Script error.')", () => {
    const buffer = bufferEarlyErrors(target);
    fireError(null);

    const reporter = { captureException: vi.fn() };
    buffer.flush(reporter);

    expect(reporter.captureException).not.toHaveBeenCalled();
  });

  it("stops buffering once the SDK loads early, so nothing is reported twice", () => {
    const buffer = bufferEarlyErrors(target);
    const early = new Error("early");
    fireError(early);
    const reporter = { captureException: vi.fn() };
    // e.g. global-error.tsx loaded the SDK before the idle-time load.
    buffer.flush(reporter);

    // Sentry's own handlers report this one; the buffer must not.
    fireError(new Error("after load"));
    buffer.flush(reporter);

    expect(reporter.captureException).toHaveBeenCalledTimes(1);
    expect(reporter.captureException).toHaveBeenCalledWith(early, expect.anything());
  });
});
