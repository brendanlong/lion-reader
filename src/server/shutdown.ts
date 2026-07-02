/**
 * Cross-bundle handoff for graceful shutdown.
 *
 * The custom HTTP server (scripts/server.ts) owns the listening socket, so it
 * orchestrates shutdown: stop accepting connections, drain in-flight requests
 * and SSE streams, then close shared resources (DB pool, Redis, metrics
 * server). Those resources live in the Next.js runtime's module graph, which
 * is a *different copy* of this module in production (dist/server.js is a
 * separate esbuild bundle), so the cleanup function is handed over on
 * globalThis under a Symbol.for key — the global symbol registry is shared
 * across all module copies in the process. instrumentation.ts registers the
 * cleanup; scripts/server.ts looks it up and calls it after the HTTP server
 * has fully closed.
 */

export type ResourceCleanup = () => Promise<void>;

const CLEANUP_KEY = Symbol.for("lionReader.resourceCleanup");

type GlobalWithCleanup = typeof globalThis & {
  [CLEANUP_KEY]?: ResourceCleanup;
};

/** Called by instrumentation.ts once the Next.js runtime has initialized. */
export function registerResourceCleanup(cleanup: ResourceCleanup): void {
  (globalThis as GlobalWithCleanup)[CLEANUP_KEY] = cleanup;
}

/**
 * Called by the custom server during shutdown. Undefined if the Next.js
 * runtime never initialized (e.g. a signal arrived before the first request
 * in dev).
 */
export function getResourceCleanup(): ResourceCleanup | undefined {
  return (globalThis as GlobalWithCleanup)[CLEANUP_KEY];
}
