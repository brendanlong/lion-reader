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
 * unreadable or malformed catalog) is a failure, because assuming "probably
 * fine" is the failure mode this exists to catch. A run that never pings
 * (Worker broken, cron gone) is caught by the check's own timeout.
 *
 * The key can only list the bucket (backup-health/tigris-policy.json): reading
 * `backup.info` would need a policy that could also download the backups, and
 * Tigris doesn't match wildcards mid-path. So success is judged from the
 * listing: barman uploads `data.tar` as a multipart upload, which only appears
 * once complete, and a failed backup leaves just its `backup.info`. A backup
 * that fails after uploading its data looks successful; that's the cost of a
 * key that can't read the database.
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
 * listing may use all but the one the ping needs.
 */
export const SUBREQUEST_LIMIT = 50;

const USER_AGENT = "LionReader-BackupHealth/1.0 (+https://github.com/brendanlong/lion-reader)";

/** barman's base archive: `data.tar`, plus a suffix when compressed. */
const DATA_ARCHIVE = /^data\.tar(\.[a-z0-9]+)?$/;

export interface CatalogObject {
  /** Key relative to `<server>/base/`, e.g. `20261020T115543/data.tar`. */
  path: string;
  lastModified: Date;
}

export interface Backup {
  /** barman's backup ID: its start time, `%Y%m%dT%H%M%S`. */
  id: string;
  hasData: boolean;
  /** When the backup's newest file was written; barman writes `backup.info` last. */
  finishedAt: Date;
}

export interface Assessment {
  healthy: boolean;
  report: string;
}

// parseTagValue: false keeps continuation tokens strings; an all-digit token
// coerced to a number loses precision.
const xmlParser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

interface ListBucketResult {
  Contents?: ListedObject | ListedObject[];
  IsTruncated?: string;
  NextContinuationToken?: string;
}

interface ListedObject {
  Key?: string;
  LastModified?: string;
}

/**
 * Parses one `ListObjectsV2` page. Throws on a malformed page: S3 can fail
 * mid-response after a 200 status.
 */
export function parseBackupListPage(
  xml: string,
  prefix: string
): { objects: CatalogObject[]; nextContinuationToken: string | null } {
  if (XMLValidator.validate(xml) !== true) throw new Error("Backup listing is not valid XML");
  const result = (xmlParser.parse(xml) as { ListBucketResult?: ListBucketResult }).ListBucketResult;
  if (!result) throw new Error("Backup listing has no ListBucketResult");

  const contents = result.Contents ?? [];
  const objects = (Array.isArray(contents) ? contents : [contents]).map((entry) => {
    const lastModified = new Date(entry.LastModified ?? "");
    if (!entry.Key?.startsWith(prefix) || Number.isNaN(lastModified.getTime())) {
      throw new Error(`Backup listing has a malformed entry: ${JSON.stringify(entry)}`);
    }
    return { path: entry.Key.slice(prefix.length), lastModified };
  });

  if (result.IsTruncated !== "true") return { objects, nextContinuationToken: null };
  if (!result.NextContinuationToken) {
    throw new Error("Backup listing is truncated but has no continuation token");
  }
  return { objects, nextContinuationToken: result.NextContinuationToken };
}

/** Groups listed files into backups, newest first. */
export function groupBackups(objects: CatalogObject[]): Backup[] {
  const backups = new Map<string, Backup>();
  for (const { path, lastModified } of objects) {
    const slash = path.indexOf("/");
    if (slash <= 0) continue;
    const id = path.slice(0, slash);
    const backup = backups.get(id) ?? { id, hasData: false, finishedAt: lastModified };
    if (DATA_ARCHIVE.test(path.slice(slash + 1))) backup.hasData = true;
    if (lastModified > backup.finishedAt) backup.finishedAt = lastModified;
    backups.set(id, backup);
  }
  // IDs are start timestamps, so they sort chronologically.
  return [...backups.values()].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}

export function assessBackups(backups: Backup[], now: Date): Assessment {
  const successIndex = backups.findIndex((b) => b.hasData);
  const success = backups[successIndex];

  const lines: string[] = [];
  let healthy = false;
  if (backups.length === 0) {
    lines.push("No base backups in the catalog.");
  } else if (!success) {
    lines.push("No base backup in the catalog has a data archive.");
  } else {
    const ageMs = now.getTime() - success.finishedAt.getTime();
    healthy = ageMs <= MAX_BACKUP_AGE_MS;
    lines.push(
      `Newest successful base backup is ${Math.floor(ageMs / 3_600_000)}h old (threshold: ${MAX_BACKUP_AGE_MS / 3_600_000}h)`,
      `Newest successful backup: ${success.id} (${success.finishedAt.toISOString()})`
    );
  }
  lines.push(
    `Failed backups newer than that: ${success ? successIndex : backups.length}`,
    `Backups in catalog: ${backups.length}`
  );
  if (!healthy) {
    lines.push("", "Investigate: fly ssh console -a lion-reader-pg -C 'flexctl backup list'");
  }
  return { healthy, report: [`Status: ${healthy ? "healthy" : "unhealthy"}`, ...lines].join("\n") };
}

async function listCatalog(env: Env): Promise<CatalogObject[]> {
  const client = new AwsClient({
    accessKeyId: env.BACKUP_ACCESS_KEY_ID,
    secretAccessKey: env.BACKUP_SECRET_ACCESS_KEY,
    service: "s3",
    region: "auto",
    // Every retry is a subrequest the budget below doesn't see; a failed run
    // reports and the next hourly one tries again.
    retries: 0,
  });
  const prefix = `${env.BACKUP_SERVER_NAME}/base/`;
  // The heartbeat ping needs the last subrequest.
  let requestsLeft = SUBREQUEST_LIMIT - 1;

  const objects: CatalogObject[] = [];
  let continuationToken: string | null = null;
  do {
    if (requestsLeft === 0) throw new Error("Backup listing needs more pages than a run can fetch");
    const url = new URL(`${env.BACKUP_BUCKET_ENDPOINT.replace(/\/$/, "")}/${env.BACKUP_BUCKET}`);
    url.searchParams.set("list-type", "2");
    url.searchParams.set("prefix", prefix);
    if (continuationToken) url.searchParams.set("continuation-token", continuationToken);
    requestsLeft--;
    const response = await client.fetch(url.toString(), { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new Error(`Listing backups failed: HTTP ${response.status}`);
    const page = parseBackupListPage(await response.text(), prefix);
    objects.push(...page.objects);
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);
  return objects;
}

export async function checkAndPing(env: Env): Promise<void> {
  let assessment: Assessment;
  try {
    assessment = assessBackups(groupBackups(await listCatalog(env)), new Date());
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
