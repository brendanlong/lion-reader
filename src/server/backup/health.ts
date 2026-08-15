/**
 * Postgres base-backup health monitoring.
 *
 * Implements the invariant "a base backup must have completed successfully in
 * the last N hours". Our Fly Postgres cluster takes a daily `barman-cloud-backup`
 * to object storage; when that starts failing, **nothing else notices**:
 * WAL archiving keeps working and reports healthy, the app keeps serving, and
 * the only record of the failure is `flexctl backup list` on the database
 * machine. Backups failed for 14 days before anyone looked (2026-08-01 →
 * 2026-08-15), so this check reads the backup catalog directly.
 *
 * WAL archiving health is deliberately *not* a proxy for this: WAL is only
 * replayable from a base backup, so an archive that is perfectly current is
 * still unrestorable once the newest base backup ages out of retention.
 *
 * The snapshot/evaluation split keeps the alerting rule pure and unit-testable;
 * the periodic monitor_backup_health job
 * (src/server/jobs/handlers/monitor-backup-health.ts) takes a snapshot,
 * evaluates it, and pings the configured healthchecks.io check.
 */

import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";

import { logger } from "@/lib/logger";
import { backupHealthConfig } from "@/server/config/env";
import { USER_AGENT } from "@/server/http/user-agent";

/**
 * How many of the newest backups to inspect per run.
 *
 * Each one costs a small GET, and a broken cluster retries ~11 times a day, so
 * this is roughly three days of history — comfortably more than the alert
 * threshold while keeping the request count bounded. Looking further back adds
 * nothing: a successful backup older than the threshold is just as much of an
 * alert as none at all.
 */
const BACKUP_SCAN_LIMIT = 30;

const REQUEST_TIMEOUT_MS = 15_000;

/** Returns true when the backup catalog is configured and can be read. */
export function isBackupHealthConfigured(): boolean {
  return !!(
    backupHealthConfig.bucket &&
    backupHealthConfig.accessKeyId &&
    backupHealthConfig.secretAccessKey &&
    backupHealthConfig.serverName
  );
}

let backupClient: AwsClient | null = null;

function getBackupClient(): AwsClient {
  if (!backupClient) {
    backupClient = new AwsClient({
      accessKeyId: backupHealthConfig.accessKeyId!,
      secretAccessKey: backupHealthConfig.secretAccessKey!,
      service: "s3",
      region: backupHealthConfig.region,
      retries: 2,
    });
  }
  return backupClient;
}

/** Path-style addressing: Tigris (and most S3-compatible endpoints) require it. */
function bucketUrl(): string {
  return `${backupHealthConfig.endpoint.replace(/\/$/, "")}/${backupHealthConfig.bucket}`;
}

/**
 * Minimal shape we read out of an S3 `ListObjectsV2` response. The response is
 * small and operator-controlled (not user input), so a DOM parse is fine here —
 * the SAX-preferred rule in CLAUDE.md is about untrusted/large documents.
 */
interface ListResponse {
  ListBucketResult?: {
    CommonPrefixes?: { Prefix?: string } | { Prefix?: string }[];
    IsTruncated?: boolean;
    NextContinuationToken?: string;
  };
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * Lists the backup IDs in the catalog, newest first.
 *
 * Uses `delimiter=/` so the listing returns one entry per backup directory
 * rather than every file inside it — a base backup contains multi-GB data
 * objects we have no reason to enumerate.
 */
async function listBackupIds(): Promise<string[]> {
  const client = getBackupClient();
  const parser = new XMLParser({ ignoreAttributes: true });
  const prefix = `${backupHealthConfig.serverName}/base/`;
  const ids: string[] = [];
  let continuationToken: string | undefined;

  // Bounded: a catalog large enough to need more pages than this would mean
  // retention is broken too, and we'd still have plenty of IDs to judge on.
  for (let page = 0; page < 10; page++) {
    const url = new URL(bucketUrl());
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("delimiter", "/");
    if (continuationToken) {
      url.searchParams.set("continuation-token", continuationToken);
    }

    const response = await client.fetch(url.toString(), {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Listing backups failed: HTTP ${response.status}`);
    }

    const parsed = parser.parse(await response.text()) as ListResponse;
    const result = parsed.ListBucketResult;
    for (const entry of toArray(result?.CommonPrefixes)) {
      // "<server>/base/<id>/" -> "<id>"
      const id = entry.Prefix?.slice(prefix.length).replace(/\/$/, "");
      if (id) ids.push(id);
    }

    if (!result?.IsTruncated || !result.NextContinuationToken) break;
    continuationToken = result.NextContinuationToken;
  }

  // Backup IDs are `YYYYMMDDTHHMMSS`, so lexicographic order is chronological.
  return ids.sort().reverse();
}

/**
 * Reads one backup's status.
 *
 * Returns the completion time from the object's `Last-Modified` rather than
 * parsing `end_time` out of the body: barman writes that field in `ctime`
 * format (`Fri Aug  1 01:43:04 2026`) with no timezone, whereas `Last-Modified`
 * is unambiguous UTC and is stamped when the final status is written.
 */
async function readBackupStatus(
  id: string
): Promise<{ done: boolean; completedAt: Date | null } | null> {
  const client = getBackupClient();
  const key = `${backupHealthConfig.serverName}/base/${id}/backup.info`;

  const response = await client.fetch(`${bucketUrl()}/${key}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Reading ${key} failed: HTTP ${response.status}`);
  }

  const body = await response.text();
  const done = /^status\s*=\s*DONE\s*$/m.test(body);
  const lastModified = response.headers.get("last-modified");
  const completedAt = lastModified ? new Date(lastModified) : null;

  return {
    done,
    completedAt: completedAt && !Number.isNaN(completedAt.getTime()) ? completedAt : null,
  };
}

/** Snapshot of base-backup state from the backup catalog. */
export interface BackupHealthSnapshot {
  /** Completion time of the newest successful backup found, or null if none. */
  lastSuccessfulBackupAt: Date | null;
  /** ID of that backup, for the alert body. */
  lastSuccessfulBackupId: string | null;
  /** How many backups were inspected (newest first, up to BACKUP_SCAN_LIMIT). */
  scannedCount: number;
  /** How many of those were not DONE. */
  failedCount: number;
  /** Oldest backup ID inspected, so an alert can say how far back we looked. */
  oldestScannedId: string | null;
  /** Total backups in the catalog. Zero means backups have never run. */
  catalogSize: number;
}

/**
 * Reads the current base-backup health snapshot from object storage.
 *
 * Scans newest-first and stops at the first successful backup, so a healthy
 * cluster costs one list plus one GET.
 */
export async function getBackupHealthSnapshot(): Promise<BackupHealthSnapshot> {
  const ids = await listBackupIds();
  const scanned = ids.slice(0, BACKUP_SCAN_LIMIT);

  let failedCount = 0;
  for (const id of scanned) {
    const status = await readBackupStatus(id);
    if (status?.done) {
      return {
        lastSuccessfulBackupAt: status.completedAt,
        lastSuccessfulBackupId: id,
        scannedCount: failedCount + 1,
        failedCount,
        oldestScannedId: id,
        catalogSize: ids.length,
      };
    }
    failedCount++;
  }

  return {
    lastSuccessfulBackupAt: null,
    lastSuccessfulBackupId: null,
    scannedCount: scanned.length,
    failedCount,
    oldestScannedId: scanned.at(-1) ?? null,
    catalogSize: ids.length,
  };
}

export type BackupHealthStatus = "healthy" | "unhealthy";

/** Result of evaluating a backup health snapshot. */
export interface BackupHealthEvaluation {
  status: BackupHealthStatus;
  /** Human-readable explanation, used in alerts and logs. */
  reason: string;
  /** Age of the newest successful backup, or null if there is none. */
  lastSuccessAgeMs: number | null;
}

/**
 * Evaluates a snapshot against the maximum allowed successful-backup age.
 *
 * Pure function (no I/O) so the alerting rule itself is unit-testable.
 *
 * - Empty catalog: unhealthy. Backups are configured (the job doesn't run
 *   otherwise) but have never produced anything, which is exactly as bad as
 *   them having stopped.
 * - No successful backup within the scanned window: unhealthy.
 * - Newest success older than maxAgeMs: unhealthy.
 *
 * A successful backup with an unknown completion time is treated as unhealthy
 * rather than assumed current: this check exists because a silent failure went
 * unnoticed for two weeks, so it fails closed.
 */
export function evaluateBackupHealth(
  snapshot: BackupHealthSnapshot,
  now: Date,
  maxAgeMs: number
): BackupHealthEvaluation {
  if (snapshot.catalogSize === 0) {
    return {
      status: "unhealthy",
      reason: "No base backups exist in the catalog",
      lastSuccessAgeMs: null,
    };
  }

  if (snapshot.lastSuccessfulBackupAt === null) {
    const scope = snapshot.oldestScannedId
      ? ` (checked the newest ${snapshot.scannedCount}, back to ${snapshot.oldestScannedId})`
      : "";
    return {
      status: "unhealthy",
      reason: `No successful base backup found${scope}`,
      lastSuccessAgeMs: null,
    };
  }

  const ageMs = now.getTime() - snapshot.lastSuccessfulBackupAt.getTime();
  if (ageMs > maxAgeMs) {
    return {
      status: "unhealthy",
      reason:
        `Newest successful base backup is ${Math.round(ageMs / 3_600_000)}h old ` +
        `(threshold: ${Math.round(maxAgeMs / 3_600_000)}h)`,
      lastSuccessAgeMs: ageMs,
    };
  }

  return {
    status: "healthy",
    reason: `Successful base backup ${Math.round(ageMs / 3_600_000)}h ago`,
    lastSuccessAgeMs: ageMs,
  };
}

/**
 * Builds the healthchecks.io ping body for a backup-health run. This text is
 * included in the monitor's notification emails, so it must explain *why* the
 * check is failing — and what to run next — without opening the app.
 */
export function buildBackupHealthPingBody(
  snapshot: BackupHealthSnapshot,
  evaluation: BackupHealthEvaluation
): string {
  const lines = [
    `Status: ${evaluation.status}`,
    evaluation.reason,
    `Newest successful backup: ${
      snapshot.lastSuccessfulBackupId
        ? `${snapshot.lastSuccessfulBackupId} (${snapshot.lastSuccessfulBackupAt?.toISOString() ?? "completion time unknown"})`
        : "none found"
    }`,
    `Failed backups newer than that: ${snapshot.failedCount}`,
    `Backups in catalog: ${snapshot.catalogSize}`,
  ];
  if (evaluation.status === "unhealthy") {
    lines.push("", "Investigate: fly ssh console -a lion-reader-pg -C 'flexctl backup list'");
  }
  return lines.join("\n");
}

/** Logs and swallows a catalog read failure, so monitoring never breaks the worker. */
export function logBackupHealthReadFailure(error: unknown): void {
  logger.error("Could not read the backup catalog", {
    error: error instanceof Error ? error.message : "Unknown error",
    bucket: backupHealthConfig.bucket,
    serverName: backupHealthConfig.serverName,
  });
}
