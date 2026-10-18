/**
 * Graceful shutdown for every long-running process (app server, worker,
 * Discord bot): one sequence, one deadline, one set of signal handlers.
 *
 * Kept free of heavy imports (DB, Redis, metrics) because the custom server
 * bundle (scripts/server.ts) imports it, and its copies of those modules are
 * not the ones the Next.js runtime uses — see the resource cleanup handoff
 * below.
 */

import { logger } from "@/lib/logger";

const dev = process.env.NODE_ENV !== "production";

/**
 * How long in-flight work (requests, SSE streams, jobs, bot handlers) gets to
 * finish before a process stops waiting for it. Short in dev so Ctrl+C is snappy.
 */
export const DRAIN_TIMEOUT_MS = dev ? 1_000 : 15_000;

/**
 * Hard deadline for a whole shutdown (drain + resource cleanup). Must stay under
 * fly.toml's `kill_timeout` (30s), after which Fly SIGKILLs the process.
 */
export const SHUTDOWN_DEADLINE_MS = DRAIN_TIMEOUT_MS + 10_000;

interface ShutdownSequence {
  /**
   * Stops taking new work and waits for current work. `timeout` aborts after
   * `drainTimeoutMs`: drain must then stop waiting and resolve promptly.
   */
  drain: (timeout: AbortSignal) => Promise<void>;
  /** Closes shared resources. `drained` is false if the drain timed out. */
  cleanup: (result: { drained: boolean }) => Promise<void>;
  drainTimeoutMs: number;
  deadlineMs: number;
  exit: (code: number) => void;
}

/**
 * Returns a function that runs `drain`, then `cleanup`, then exits — once: later
 * calls (a second signal, a failure during shutdown) are ignored. Exits 1 if a
 * step throws, or if the whole sequence outlasts `deadlineMs`.
 */
export function createShutdown({
  drain,
  cleanup,
  drainTimeoutMs,
  deadlineMs,
  exit,
}: ShutdownSequence): (reason: string, exitCode?: number) => void {
  let started = false;

  return (reason, exitCode = 0) => {
    if (started) {
      logger.info(`Already shutting down; ignoring ${reason}`);
      return;
    }
    started = true;
    logger.info(`Shutting down (${reason})...`, { drainTimeoutMs, deadlineMs });

    const deadline = setTimeout(() => {
      logger.error("Shutdown did not complete in time, forcing exit");
      exit(1);
    }, deadlineMs);
    const drainTimeout = new AbortController();
    const drainTimer = setTimeout(() => drainTimeout.abort(), drainTimeoutMs);

    void (async () => {
      let code = exitCode;
      try {
        await drain(drainTimeout.signal);
        clearTimeout(drainTimer);
        await cleanup({ drained: !drainTimeout.signal.aborted });
        logger.info("Graceful shutdown complete");
      } catch (error) {
        logger.error("Error during shutdown", { error });
        code = 1;
      }
      clearTimeout(drainTimer);
      clearTimeout(deadline);
      exit(code);
    })();
  };
}

/**
 * Wires SIGTERM/SIGINT to `shutdown`, and logs Node process warnings
 * (deprecations etc.) as structured logs instead of stderr lines that scroll
 * past in `fly logs`.
 */
export function handleProcessSignals(shutdown: (reason: string) => void): void {
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("warning", (warning) => {
    logger.warn("Node process warning", {
      name: warning.name,
      message: warning.message,
      stack: warning.stack,
    });
  });
}

// ============================================================================
// Cross-bundle resource cleanup handoff (app server)
// ============================================================================

/*
 * The app's shared resources (DB pool, Redis, metrics server) live in the
 * Next.js runtime's module graph, which is a *different copy* of this module in
 * production (dist/server.js is a separate esbuild bundle), so the cleanup
 * function is handed over on globalThis under a Symbol.for key — the global
 * symbol registry is shared across all module copies in the process.
 * instrumentation.ts registers the cleanup; scripts/server.ts looks it up and
 * calls it after the HTTP server has fully closed.
 */

type ResourceCleanup = () => Promise<void>;

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
