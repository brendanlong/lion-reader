/**
 * Bootstrap for the standalone processes (scripts/worker.ts,
 * scripts/discord-bot.ts): Sentry, startup log, metrics/health server,
 * healthchecks.io heartbeat, and a graceful shutdown that fits inside fly.toml's
 * kill_timeout. The app server can't use it — its resources live in the Next.js
 * runtime's module graph (src/instrumentation.ts) — but it shares the shutdown
 * sequence (src/server/shutdown.ts) and {@link closeSharedResources}.
 */

import * as Sentry from "@sentry/nextjs";
import { isMainThread, threadId } from "node:worker_threads";
import { logger } from "@/lib/logger";
import { pool } from "@/server/db";
import {
  setHealthChecker,
  startMetricsServer,
  stopMetricsServer,
  type HealthCheckResult,
} from "@/server/metrics/server";
import { startHeartbeat, type HeartbeatStatus } from "@/server/notifications/healthchecks";
import { closeRedisClient } from "@/server/redis";
import { initSentry } from "@/server/sentry";
import {
  createShutdown,
  handleProcessSignals,
  DRAIN_TIMEOUT_MS,
  SHUTDOWN_DEADLINE_MS,
} from "@/server/shutdown";

/** How long to wait for buffered Sentry events to send before exiting. */
const SENTRY_FLUSH_TIMEOUT_MS = 2000;

/**
 * Closes the process's shared resources, in dependency order: the metrics
 * server first (a scrape reads the DB pool), then Sentry (errors captured while
 * draining are the ones most worth keeping), then Redis and the DB pool.
 */
export async function closeSharedResources(): Promise<void> {
  logger.info("Closing shared resources...");
  await stopMetricsServer();
  await Sentry.close(SENTRY_FLUSH_TIMEOUT_MS);
  await closeRedisClient();
  await pool.end();
}

/** What a started process hands back to {@link runProcess}. */
interface RunningService {
  /** Stops taking new work and resolves once current work is done. */
  stop: () => Promise<void>;
  /** Backs the metrics server's /health (Fly restarts the machine on a 503). */
  checkHealth?: () => HealthCheckResult;
  /** What each heartbeat tick sends; defaults to a plain "alive" ping. */
  heartbeatStatus?: () => HeartbeatStatus;
}

interface ProcessOptions {
  /** Used in log lines, e.g. "Starting standalone worker". */
  name: string;
  /** The port fly.toml's [[metrics]] and [checks] use for this process group. */
  metricsPort: number;
  includeDatabaseMetrics?: boolean;
  /** Extra fields for the startup log line. */
  details?: Record<string, unknown>;
  /** healthchecks.io check pinged while the process is running (no-op without a URL). */
  heartbeat?: { url: string | undefined; intervalMs: number };
  /**
   * Starts the work. Resolves to null when the process is disabled by config:
   * it then idles (so Fly's restart policy doesn't loop it) without pinging the
   * heartbeat. `fail` shuts the process down with exit code 1 (the error should
   * already be reported).
   */
  start: (fail: (reason: string) => void) => Promise<RunningService | null>;
}

export function runProcess({
  name,
  metricsPort,
  includeDatabaseMetrics,
  details,
  heartbeat,
  start,
}: ProcessOptions): void {
  // Next.js instrumentation only runs in the app server, so without this the
  // process's Sentry.captureException calls are silent no-ops. It also installs
  // Sentry's global uncaught-exception / unhandled-rejection handlers.
  initSentry();

  logger.info(`Starting ${name}`, {
    ...details,
    pid: process.pid,
    // Machine identity: a startup line carrying the wrong process group is the
    // smoking gun for a machine running the wrong binary.
    flyProcessGroup: process.env.FLY_PROCESS_GROUP,
    flyMachineId: process.env.FLY_MACHINE_ID,
    // Thread identity: worker threads share the parent's pid, so pid alone can't
    // tell "second OS process on this machine" from "this bundle was loaded
    // inside another process's worker thread (a wrongly-resolved thread
    // bootstrap)". isMainThread=false means the latter.
    isMainThread,
    threadId,
  });

  startMetricsServer(metricsPort, { includeDatabaseMetrics });

  let service: RunningService | null = null;
  let stopping = false;
  let stopHeartbeat: (() => void) | undefined;
  let idleTimer: NodeJS.Timeout | undefined;

  const shutdown = createShutdown({
    drainTimeoutMs: DRAIN_TIMEOUT_MS,
    deadlineMs: SHUTDOWN_DEADLINE_MS,
    exit: (code) => process.exit(code),
    drain: async (timeout) => {
      stopping = true;
      stopHeartbeat?.();
      clearInterval(idleTimer);
      if (!service) return;
      const timedOut = new Promise<void>((resolve) =>
        timeout.addEventListener("abort", () => resolve(), { once: true })
      );
      await Promise.race([service.stop(), timedOut]);
    },
    cleanup: async ({ drained }) => {
      if (drained) {
        await closeSharedResources();
        return;
      }
      // Work is still running against the DB pool and Redis, so leave them
      // open: closing them would only turn that work's last writes into errors.
      // An interrupted job keeps its lease until it goes stale, then another
      // worker reclaims and retries it (STALE_JOB_THRESHOLD_MS in jobs/queue.ts).
      logger.warn(`${name} did not stop within ${DRAIN_TIMEOUT_MS}ms; exiting anyway`);
      await Sentry.close(SENTRY_FLUSH_TIMEOUT_MS);
    },
  });
  handleProcessSignals(shutdown);

  start((reason) => shutdown(reason, 1)).then(
    (started) => {
      if (stopping) return;
      if (!started) {
        logger.info(`${name} disabled by config; idling until stopped`);
        idleTimer = setInterval(() => {}, 2 ** 31 - 1);
        return;
      }
      service = started;
      logger.info(`Started ${name}`);
      if (started.checkHealth) setHealthChecker(started.checkHealth);
      // Only once started, so a process that fails to start never reports
      // itself alive.
      if (heartbeat?.url) {
        const machine = process.env.FLY_MACHINE_ID || process.env.HOSTNAME || "unknown";
        const region = process.env.FLY_REGION || "unknown";
        const body = `${name} alive (machine=${machine} region=${region} pid=${process.pid})`;
        stopHeartbeat = startHeartbeat(
          heartbeat.url,
          heartbeat.intervalMs,
          started.heartbeatStatus ?? (() => ({ body }))
        );
      }
    },
    (error: unknown) => {
      logger.error(`Failed to start ${name}`, { error });
      Sentry.captureException(error, { tags: { context: "process-start" } });
      shutdown("startup failure", 1);
    }
  );
}
