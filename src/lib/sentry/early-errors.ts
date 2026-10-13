/**
 * Buffers uncaught errors and unhandled rejections raised before the
 * lazily-loaded Sentry SDK (`./client.ts`) is initialized, so they're still
 * reported once it is.
 */

type ErrorMechanismType = "onerror" | "onunhandledrejection";

interface ErrorReporter {
  captureException(
    error: unknown,
    hint: { mechanism: { type: ErrorMechanismType; handled: false } }
  ): unknown;
}

export interface EarlyErrorBuffer {
  /**
   * Stops buffering and reports what was buffered, as unhandled (like Sentry's
   * own global handlers, which take over once the SDK is initialized). Only
   * the first call does anything; pass null when the SDK failed to load.
   */
  flush(reporter: ErrorReporter | null): void;
}

export function bufferEarlyErrors(
  target: Pick<Window, "addEventListener" | "removeEventListener">
): EarlyErrorBuffer {
  const pending: Array<{ error: unknown; type: ErrorMechanismType }> = [];
  // `error` is null for cross-origin "Script error." events, which carry
  // nothing to report.
  const onError = (event: ErrorEvent) => {
    if (event.error != null) pending.push({ error: event.error, type: "onerror" });
  };
  const onRejection = (event: PromiseRejectionEvent) =>
    pending.push({ error: event.reason, type: "onunhandledrejection" });
  target.addEventListener("error", onError);
  target.addEventListener("unhandledrejection", onRejection);

  let flushed = false;
  return {
    flush(reporter) {
      if (flushed) return;
      flushed = true;
      target.removeEventListener("error", onError);
      target.removeEventListener("unhandledrejection", onRejection);
      for (const { error, type } of pending.splice(0)) {
        reporter?.captureException(error, { mechanism: { type, handled: false } });
      }
    },
  };
}
