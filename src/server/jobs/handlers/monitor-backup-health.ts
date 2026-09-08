/**
 * Handler for `monitor_backup_health` jobs (singleton).
 *
 * See src/server/backup/health.ts for the invariant this checks.
 */

import type { BackupHealthSnapshot } from "../../backup/health";
import {
  getBackupHealthSnapshot,
  evaluateBackupHealth,
  buildBackupHealthPingBody,
  isBackupHealthConfigured,
  logBackupHealthReadFailure,
} from "../../backup/health";
import { pingHealthcheck } from "../../notifications/healthchecks";
import { backupHealthConfig } from "../../config/env";
import { updateBackupHealthMetrics } from "../../metrics/metrics";
import type { JobPayloads } from "../queue";
import { logger } from "@/lib/logger";
import type { JobHandlerResult } from "./types";

/** How often the base-backup health check runs. */
const BACKUP_HEALTH_CHECK_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Handler for monitor_backup_health jobs (singleton, runs hourly).
 *
 * Checks the invariant "a base backup completed successfully recently"
 * (see src/server/backup/health.ts) and:
 * - Pings the configured healthchecks.io check (BACKUP_HEALTH_HEARTBEAT_URL):
 *   success when a recent backup exists, `/fail` with an explanatory body when
 *   not.
 * - Updates the backup health Prometheus gauges.
 *
 * Hourly rather than per-backup because the signal being watched is "the newest
 * success has aged out", which changes slowly; a tighter interval would just
 * add object-storage requests without detecting anything sooner.
 *
 * A catalog we cannot read is reported as a `/fail`, not skipped: "the monitor
 * is broken" and "backups are broken" both need a human, and staying silent
 * about either is the failure mode this check exists to remove.
 *
 * No alert state is kept here: healthchecks.io de-duplicates notifications and
 * sends its own recovery email, so the job just reports status each run.
 */
export async function handleMonitorBackupHealth(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _payload: JobPayloads["monitor_backup_health"]
): Promise<JobHandlerResult> {
  const now = new Date();
  const nextRunAt = new Date(now.getTime() + BACKUP_HEALTH_CHECK_INTERVAL_MS);

  // Self-hosters without backup storage configured get no check and no alert.
  if (!isBackupHealthConfigured()) {
    return { success: true, nextRunAt, metadata: { status: "not_configured" } };
  }

  let snapshot: BackupHealthSnapshot;
  try {
    snapshot = await getBackupHealthSnapshot(now);
  } catch (error) {
    logBackupHealthReadFailure(error);
    updateBackupHealthMetrics(null, null);
    if (backupHealthConfig.heartbeatUrl) {
      await pingHealthcheck(backupHealthConfig.heartbeatUrl, {
        signal: "fail",
        body:
          `Status: unknown\nCould not read the backup catalog: ` +
          `${error instanceof Error ? error.message : "Unknown error"}`,
      });
    }
    return { success: true, nextRunAt, metadata: { status: "unreadable" } };
  }

  const evaluation = evaluateBackupHealth(
    snapshot,
    now,
    backupHealthConfig.maxAgeHours * 60 * 60 * 1000
  );

  updateBackupHealthMetrics(
    snapshot.lastSuccessfulBackupAt !== null
      ? snapshot.lastSuccessfulBackupAt.getTime() / 1000
      : null,
    snapshot.failedCount
  );

  if (evaluation.status === "unhealthy") {
    // warn, not error: logger.error reports to Sentry, and this check runs
    // hourly for as long as an outage lasts — long outages are the norm here,
    // so that would be hundreds of duplicate events. healthchecks.io de-dupes
    // and sends its own recovery notification, so it owns alerting — the same
    // split as monitor_feed_health.
    logger.warn("Base backup health check failed", {
      reason: evaluation.reason,
      lastSuccessfulBackupId: snapshot.lastSuccessfulBackupId,
      lastSuccessfulBackupAt: snapshot.lastSuccessfulBackupAt?.toISOString(),
      failedCount: snapshot.failedCount,
      backupInProgress: snapshot.backupInProgress,
      catalogSize: snapshot.catalogSize,
    });
  }

  if (backupHealthConfig.heartbeatUrl) {
    await pingHealthcheck(backupHealthConfig.heartbeatUrl, {
      signal: evaluation.status === "healthy" ? "success" : "fail",
      body: buildBackupHealthPingBody(snapshot, evaluation),
    });
  }

  return {
    success: true,
    nextRunAt,
    metadata: {
      status: evaluation.status,
      reason: evaluation.reason,
      lastSuccessAgeMs: evaluation.lastSuccessAgeMs ?? undefined,
      failedCount: snapshot.failedCount,
      catalogSize: snapshot.catalogSize,
    },
  };
}
