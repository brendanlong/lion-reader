/**
 * Client-side Sentry, loaded asynchronously.
 *
 * The browser SDK is large, so nothing on the critical path imports
 * `@sentry/nextjs`: `instrumentation-client.ts` calls `loadSentry()` once the
 * page is idle, and client code reports errors through
 * `captureClientException`, which loads the SDK first if it isn't yet.
 */

type SentrySdk = typeof import("./client-sdk");

// NEXT_PUBLIC_* vars are inlined at build time, so the DSN must be available
// to `next build` (not just at runtime) for client Sentry to work.
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

let sdk: Promise<SentrySdk | null> | null = null;

/** Loads and initializes the SDK once. Resolves to null when it's not configured or fails to load. */
export function loadSentry(): Promise<SentrySdk | null> {
  sdk ??= dsn
    ? import("./client-sdk").then(
        (loaded) => {
          loaded.initSentry(dsn);
          return loaded;
        },
        () => null
      )
    : Promise.resolve(null);
  return sdk;
}

export function captureClientException(error: unknown): void {
  void loadSentry().then((loaded) => loaded?.captureException(error));
}
