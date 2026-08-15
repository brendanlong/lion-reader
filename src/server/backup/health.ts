/**
 * Postgres base-backup health monitoring.
 *
 * Implements the invariant "a base backup must have completed successfully in
 * the last N hours". Our Fly Postgres cluster takes a daily `barman-cloud-backup`
 * to object storage; when that starts failing, **nothing else notices**: WAL
 * archiving keeps working and reports healthy, the app keeps serving, and the
 * only record is `flexctl backup list` on the database machine. Backups failed
 * for 14 days before anyone looked, so this check reads the catalog directly.
 *
 * WAL-archive health is deliberately *not* a proxy for this: WAL is only
 * replayable from a base backup, so an archive that is perfectly current is
 * still unrestorable once the newest base backup ages out of retention.
 *
 * Catalog layout and formats below follow barman's `CloudBackup._upload_backup_info`
 * and `FieldListFile.save` (EnterpriseDB/barman `src/barman/cloud.py`,
 * `src/barman/infofile.py`).
 *
 * The snapshot/evaluation split keeps the alerting rule pure and unit-testable;
 * the periodic monitor_backup_health job
 * (src/server/jobs/handlers/monitor-backup-health.ts) takes a snapshot,
 * evaluates it, and pings the configured healthchecks.io check.
 *
 * Scope: this checks that a backup *reported* success, not that its data
 * objects are still intact — it is a "did the backup run" monitor, not a
 * restore drill. See the drill runbook in docs/fly-postgres-ops.md.
 */

import { AwsClient } from "aws4fetch";
import { XMLParser } from "fast-xml-parser";

import { logger } from "@/lib/logger";
import { backupHealthConfig } from "@/server/config/env";
import { USER_AGENT } from "@/server/http/user-agent";

/**
 * How many of the newest backups to inspect per run.
 *
 * Each costs a small GET. A broken cluster retries ~11 times a day, so this is
 * roughly a week of history — enough that the alert body can still name the
 * last good backup well after the threshold trips, which is the most useful
 * line in the notification.
 */
const BACKUP_SCAN_LIMIT = 80;

const REQUEST_TIMEOUT_MS = 10_000;

/**
 * Overall budget for a snapshot, well inside the worker's 300s job timeout.
 * Without it, the failure path (one list plus up to BACKUP_SCAN_LIMIT GETs,
 * each able to burn REQUEST_TIMEOUT_MS) could outlive the job and be reported
 * as a wedged handler.
 */
const SNAPSHOT_BUDGET_MS = 120_000;

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
    IsTruncated?: boolean | string;
    NextContinuationToken?: string;
  };
}

function toArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

/**
 * `parseTagValue: false` keeps every value a string. A continuation token can be
 * all digits, and coercing one to a JS number silently loses precision past 2^53
 * — the next page request would then 400. Booleans are compared as strings for
 * the same reason.
 */
const listParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

/** One page of a backup listing. Exported for testing; see parseBackupListPage. */
export interface BackupListPage {
  ids: string[];
  nextContinuationToken: string | null;
}

/**
 * Parses one `ListObjectsV2` page into backup IDs.
 *
 * Pure, so the XML shapes that are easy to get wrong — a single `CommonPrefixes`
 * element arriving unwrapped, an empty listing, a truncated page — are covered
 * by unit tests rather than discovered in production.
 */
export function parseBackupListPage(xml: string, prefix: string): BackupListPage {
  const parsed = listParser.parse(xml) as ListResponse;
  const result = parsed.ListBucketResult;

  const ids: string[] = [];
  for (const entry of toArray(result?.CommonPrefixes)) {
    // "<server>/base/<id>/" -> "<id>"
    const raw = entry.Prefix;
    if (typeof raw !== "string" || !raw.startsWith(prefix)) continue;
    const id = raw.slice(prefix.length).replace(/\/$/, "");
    if (id) ids.push(id);
  }

  const truncated = String(result?.IsTruncated) === "true";
  const token = result?.NextContinuationToken;
  return {
    ids,
    nextContinuationToken: truncated && token ? String(token) : null,
  };
}

/**
 * Lists the backup IDs in the catalog, newest first.
 *
 * Uses `delimiter=/` so the listing returns one entry per backup directory
 * rather than every file inside it — a base backup contains multi-GB data
 * objects we have no reason to enumerate.
 */
async function listBackupIds(deadline: number): Promise<string[]> {
  const client = getBackupClient();
  const prefix = `${backupHealthConfig.serverName}/base/`;
  const ids: string[] = [];
  let continuationToken: string | null = null;

  // Bounded: a catalog needing more pages than this would mean retention is
  // broken too, and we'd still have plenty of IDs to judge on.
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
      signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, deadline - Date.now())),
    });
    if (!response.ok) {
      throw new Error(`Listing backups failed: HTTP ${response.status}`);
    }

    const parsedPage = parseBackupListPage(await response.text(), prefix);
    ids.push(...parsedPage.ids);

    continuationToken = parsedPage.nextContinuationToken;
    if (!continuationToken || Date.now() >= deadline) break;
  }

  // Backup IDs are `datetime.now().strftime("%Y%m%dT%H%M%S")`, so lexicographic
  // order is chronological.
  return ids.sort().reverse();
}

/** Status values barman writes into `backup.info`. */
export type BarmanBackupStatus = "DONE" | "STARTED" | "FAILED" | "UNKNOWN";

/** What one backup's `backup.info` says. */
export interface BackupInfo {
  status: BarmanBackupStatus;
  /** Completion time, or null if absent/unparseable. */
  endTime: Date | null;
}

/**
 * Parses the fields we care about out of a barman `backup.info`.
 *
 * The file is `key=value` lines (`FieldListFile.save` writes `"%s=%s\n"`).
 * `end_time` is a timezone-aware Python datetime rendered by `str()`, e.g.
 * `2026-08-01 01:43:04.123456+00:00` — space-separated and with microseconds,
 * neither of which `Date` is required to accept, so both are normalised first.
 *
 * (The `Fri Aug  1 01:43:04 2026` ctime form is a different representation,
 * produced only by `BackupInfo.to_json` — i.e. by `barman-cloud-backup-list
 * --format json`, which is what `flexctl backup list` renders. It never appears
 * in the file itself.)
 */
export function parseBackupInfo(body: string): BackupInfo {
  const statusMatch = /^status\s*=\s*(\S+)\s*$/m.exec(body);
  const rawStatus = statusMatch?.[1];
  const status: BarmanBackupStatus =
    rawStatus === "DONE" || rawStatus === "STARTED" || rawStatus === "FAILED"
      ? rawStatus
      : "UNKNOWN";

  const endTimeMatch = /^end_time\s*=\s*(.+?)\s*$/m.exec(body);
  let endTime: Date | null = null;
  if (endTimeMatch?.[1] && endTimeMatch[1] !== "None") {
    const normalized = endTimeMatch[1]
      .replace(" ", "T")
      .replace(/(\.\d{3})\d+/, "$1")
      .replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) endTime = parsed;
  }

  return { status, endTime };
}

/**
 * Reads one backup's `backup.info`.
 *
 * Falls back to the object's `Last-Modified` when `end_time` is missing:
 * barman's final write of `backup.info` happens at backup end, so it is a close
 * approximation — but `end_time` is preferred because it survives any later
 * re-save of the object.
 */
async function readBackupInfo(id: string, deadline: number): Promise<BackupInfo | null> {
  const client = getBackupClient();
  const key = `${backupHealthConfig.serverName}/base/${id}/backup.info`;

  const response = await client.fetch(`${bucketUrl()}/${key}`, {
    headers: { "User-Agent": USER_AGENT },
    signal: AbortSignal.timeout(Math.min(REQUEST_TIMEOUT_MS, Math.max(deadline - Date.now(), 1))),
  });
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(`Reading ${key} failed: HTTP ${response.status}`);
  }

  const info = parseBackupInfo(await response.text());
  if (info.endTime) return info;

  const lastModified = response.headers.get("last-modified");
  const fallback = lastModified ? new Date(lastModified) : null;
  return {
    status: info.status,
    endTime: fallback && !Number.isNaN(fallback.getTime()) ? fallback : null,
  };
}

/** Snapshot of base-backup state from the backup catalog. */
export interface BackupHealthSnapshot {
  /** Completion time of the newest successful backup found, or null if none. */
  lastSuccessfulBackupAt: Date | null;
  /** ID of that backup, for the alert body. */
  lastSuccessfulBackupId: string | null;
  /** How many backups were inspected (newest first). */
  scannedCount: number;
  /** How many inspected backups had failed, excluding any still in progress. */
  failedCount: number;
  /** Whether a backup was running when we looked (its status is not yet final). */
  backupInProgress: boolean;
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
export async function getBackupHealthSnapshot(
  now: Date = new Date()
): Promise<BackupHealthSnapshot> {
  const deadline = now.getTime() + SNAPSHOT_BUDGET_MS;
  const ids = await listBackupIds(deadline);
  const scanned = ids.slice(0, BACKUP_SCAN_LIMIT);

  let failedCount = 0;
  let backupInProgress = false;
  let inspected = 0;
  let oldestScannedId: string | null = null;

  for (const id of scanned) {
    if (Date.now() >= deadline) break;
    inspected++;
    oldestScannedId = id;

    const info = await readBackupInfo(id, deadline);
    if (info?.status === "DONE") {
      return {
        lastSuccessfulBackupAt: info.endTime,
        lastSuccessfulBackupId: id,
        scannedCount: inspected,
        failedCount,
        backupInProgress,
        oldestScannedId,
        catalogSize: ids.length,
      };
    }

    // A backup running right now is the newest ID and has status=STARTED. It
    // hasn't failed, so counting it would put `backups_failing` at >=1 during
    // every healthy nightly run.
    if (info?.status === "STARTED") {
      backupInProgress = true;
    } else {
      failedCount++;
    }
  }

  return {
    lastSuccessfulBackupAt: null,
    lastSuccessfulBackupId: null,
    scannedCount: inspected,
    failedCount,
    backupInProgress,
    oldestScannedId,
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
 *   otherwise) but have never produced anything, which is as bad as them
 *   having stopped.
 * - No successful backup within the scanned window: unhealthy.
 * - Newest success older than maxAgeMs: unhealthy.
 *
 * A successful backup whose completion time is unknown is treated as unhealthy
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
    const qualifier = snapshot.lastSuccessfulBackupId
      ? `Newest successful base backup ${snapshot.lastSuccessfulBackupId} has no recorded completion time`
      : `No successful base backup found${scope}`;
    return { status: "unhealthy", reason: qualifier, lastSuccessAgeMs: null };
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
  const newest = snapshot.lastSuccessfulBackupId
    ? `${snapshot.lastSuccessfulBackupId} (${
        snapshot.lastSuccessfulBackupAt?.toISOString() ?? "completion time unknown"
      })`
    : `none found in the newest ${snapshot.scannedCount}`;

  const lines = [
    `Status: ${evaluation.status}`,
    evaluation.reason,
    `Newest successful backup: ${newest}`,
    `Failed backups newer than that: ${snapshot.failedCount}`,
    `Backups in catalog: ${snapshot.catalogSize}`,
  ];
  if (snapshot.backupInProgress) {
    lines.push("A backup is currently in progress.");
  }
  if (evaluation.status === "unhealthy") {
    lines.push("", "Investigate: fly ssh console -a lion-reader-pg -C 'flexctl backup list'");
  }
  return lines.join("\n");
}

/** Logs a catalog read failure. The caller reports it; monitoring never throws into the worker. */
export function logBackupHealthReadFailure(error: unknown): void {
  logger.error("Could not read the backup catalog", {
    error: error instanceof Error ? error.message : "Unknown error",
    bucket: backupHealthConfig.bucket,
    serverName: backupHealthConfig.serverName,
  });
}
