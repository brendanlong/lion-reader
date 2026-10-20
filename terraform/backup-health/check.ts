/**
 * The backup-health Worker's logic (entry point: ./index.ts). It alerts when
 * Postgres base backups stop succeeding (#2091); ../backup-health.tf deploys
 * and schedules it.
 *
 * It watches base backups, not WAL: WAL only replays on top of a base backup,
 * so a current WAL archive is still unrestorable once the newest base backup
 * ages out of retention. Base backups once failed for 14 days while WAL
 * archiving stayed healthy.
 *
 * Every run pings healthchecks.io: success when a base backup completed within
 * MAX_BACKUP_AGE_MS, /fail otherwise. Anything it can't establish (an
 * unreadable catalog, an unparseable completion time) is a failure, because
 * assuming "probably fine" is the failure mode this exists to catch. A run that
 * never pings (Worker broken, cron gone) is caught by the check's own timeout.
 */

import { AwsClient } from "aws4fetch";
import { XMLParser, XMLValidator } from "fast-xml-parser";

export interface Env {
  BACKUP_BUCKET_ENDPOINT: string;
  BACKUP_BUCKET: string;
  /** Top-level directory of the barman catalog: the Postgres app's name. */
  BACKUP_SERVER_NAME: string;
  BACKUP_ACCESS_KEY_ID: string;
  BACKUP_SECRET_ACCESS_KEY: string;
  HEARTBEAT_URL: string;
}

/** One daily backup cycle plus slack for a slow or retried run. */
export const MAX_BACKUP_AGE_MS = 36 * 60 * 60 * 1000;

/**
 * Requests a run may make on the free Workers plan; one more is rejected. The
 * scan reads backups until it would leave none for the ping. Running out means
 * that many failures in a row, which is worth an alert in itself.
 */
export const SUBREQUEST_LIMIT = 50;

const USER_AGENT = "LionReader-BackupHealth/1.0 (+https://github.com/brendanlong/lion-reader)";

type BackupStatus = "DONE" | "STARTED" | "FAILED" | "UNKNOWN";

export interface BackupInfo {
  status: BackupStatus;
  /** Null when absent or unparseable. */
  endTime: Date | null;
}

export interface ScannedBackup {
  id: string;
  /** Null when the backup directory has no backup.info. */
  info: BackupInfo | null;
}

export interface Assessment {
  healthy: boolean;
  report: string;
}

/**
 * Parses barman's `backup.info`: `key=value` lines, with `end_time` written by
 * Python's `str(datetime)`, e.g. `2026-08-01 01:43:04.123456+00:00`.
 */
export function parseBackupInfo(body: string): BackupInfo {
  const rawStatus = /^status=(\S+)\s*$/m.exec(body)?.[1];
  const status: BackupStatus =
    rawStatus === "DONE" || rawStatus === "STARTED" || rawStatus === "FAILED"
      ? rawStatus
      : "UNKNOWN";

  const rawEnd = /^end_time=(.+?)\s*$/m.exec(body)?.[1];
  let endTime: Date | null = null;
  if (rawEnd && rawEnd !== "None") {
    const parsed = new Date(rawEnd.replace(" ", "T").replace(/(\.\d{3})\d+/, "$1"));
    if (!Number.isNaN(parsed.getTime())) endTime = parsed;
  }
  return { status, endTime };
}

// parseTagValue: false keeps continuation tokens strings; an all-digit token
// coerced to a number loses precision.
const xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

interface ListBucketResult {
  CommonPrefixes?: { Prefix?: string } | { Prefix?: string }[];
  IsTruncated?: string;
  NextContinuationToken?: string;
}

/**
 * Parses one `ListObjectsV2` page listed with `delimiter=/` into backup IDs.
 * Throws on a malformed page: S3 can fail mid-response after a 200 status.
 */
export function parseBackupListPage(
  xml: string,
  prefix: string
): { ids: string[]; nextContinuationToken: string | null } {
  if (XMLValidator.validate(xml) !== true) throw new Error("Backup listing is not valid XML");
  const result = (xmlParser.parse(xml) as { ListBucketResult?: ListBucketResult }).ListBucketResult;
  const prefixes = result?.CommonPrefixes ?? [];
  const ids = (Array.isArray(prefixes) ? prefixes : [prefixes])
    .map((entry) => entry.Prefix)
    .filter((p): p is string => typeof p === "string" && p.startsWith(prefix))
    .map((p) => p.slice(prefix.length).replace(/\/$/, ""))
    .filter((id) => id !== "");
  if (!result) throw new Error("Backup listing has no ListBucketResult");
  if (result.IsTruncated !== "true") return { ids, nextContinuationToken: null };
  if (!result.NextContinuationToken) {
    throw new Error("Backup listing is truncated but has no continuation token");
  }
  return { ids, nextContinuationToken: result.NextContinuationToken };
}

/**
 * Judges the scanned backups, newest first, which stop at the first DONE one.
 * `catalogSize` is how many backups exist in total, scanned or not.
 */
export function assessBackups(
  scanned: ScannedBackup[],
  catalogSize: number,
  now: Date
): Assessment {
  const success = scanned.find((b) => b.info?.status === "DONE");
  const failedCount = scanned.filter((b) => b !== success && b.info?.status === "FAILED").length;

  const lines: string[] = [];
  let healthy = false;
  if (catalogSize === 0) {
    lines.push("No base backups in the catalog.");
  } else if (!success) {
    lines.push(`No successful base backup among the newest ${scanned.length}.`);
  } else if (!success.info?.endTime) {
    lines.push(`Newest successful base backup ${success.id} has no readable end_time.`);
  } else {
    const ageMs = now.getTime() - success.info.endTime.getTime();
    const ageHours = Math.floor(ageMs / 3_600_000);
    healthy = ageMs <= MAX_BACKUP_AGE_MS;
    lines.push(
      `Newest successful base backup is ${ageHours}h old (threshold: ${MAX_BACKUP_AGE_MS / 3_600_000}h)`,
      `Newest successful backup: ${success.id} (${success.info.endTime.toISOString()})`
    );
  }
  lines.push(
    `Failed backups newer than that: ${failedCount}`,
    `Backups in catalog: ${catalogSize}`
  );
  if (!healthy) {
    lines.push("", "Investigate: fly ssh console -a lion-reader-pg -C 'flexctl backup list'");
  }
  return { healthy, report: [`Status: ${healthy ? "healthy" : "unhealthy"}`, ...lines].join("\n") };
}

async function scanBackups(env: Env): Promise<{ scanned: ScannedBackup[]; catalogSize: number }> {
  const client = new AwsClient({
    accessKeyId: env.BACKUP_ACCESS_KEY_ID,
    secretAccessKey: env.BACKUP_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
    // Every retry is a subrequest the budget below doesn't see; a failed run
    // reports and the next hourly one tries again.
    retries: 0,
  });
  const bucketUrl = `${env.BACKUP_BUCKET_ENDPOINT.replace(/\/$/, "")}/${env.BACKUP_BUCKET}`;
  const prefix = `${env.BACKUP_SERVER_NAME}/base/`;
  const headers = { "User-Agent": USER_AGENT };
  // The heartbeat ping needs the last subrequest.
  let requestsLeft = SUBREQUEST_LIMIT - 1;

  // delimiter=/ returns one entry per backup directory instead of every
  // (multi-GB) data object inside it.
  const ids: string[] = [];
  let continuationToken: string | null = null;
  do {
    if (requestsLeft === 0) throw new Error("Backup listing needs more pages than a run can fetch");
    const url = new URL(bucketUrl);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    url.searchParams.set("delimiter", "/");
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
    requestsLeft--;
    const response = await client.fetch(url.toString(), { headers });
    if (!response.ok) throw new Error(`Listing backups failed: HTTP ${response.status}`);
    const page = parseBackupListPage(await response.text(), prefix);
    ids.push(...page.ids);
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);

  // Backup IDs are start timestamps (%Y%m%dT%H%M%S), so they sort chronologically.
  ids.sort().reverse();

  const scanned: ScannedBackup[] = [];
  for (const id of ids.slice(0, requestsLeft)) {
    const response = await client.fetch(`${bucketUrl}/${prefix}${id}/backup.info`, { headers });
    if (response.status !== 404 && !response.ok) {
      throw new Error(`Reading backup ${id} failed: HTTP ${response.status}`);
    }
    const info = response.ok ? parseBackupInfo(await response.text()) : null;
    scanned.push({ id, info });
    if (info?.status === "DONE") break;
  }
  return { scanned, catalogSize: ids.length };
}

export async function checkAndPing(env: Env): Promise<void> {
  let assessment: Assessment;
  try {
    const { scanned, catalogSize } = await scanBackups(env);
    assessment = assessBackups(scanned, catalogSize, new Date());
  } catch (error) {
    assessment = {
      healthy: false,
      report: `Status: unhealthy\nCould not read the backup catalog: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const pingUrl = env.HEARTBEAT_URL.replace(/\/$/, "") + (assessment.healthy ? "" : "/fail");
  const response = await fetch(pingUrl, {
    method: "POST",
    headers: { "User-Agent": USER_AGENT },
    body: assessment.report,
  });
  if (!response.ok) throw new Error(`Healthcheck ping failed: HTTP ${response.status}`);
}
