/**
 * Unit tests for base-backup health.
 *
 * Three layers, all pure: the S3 listing parse, the `backup.info` parse, and the
 * alerting rule. The dangerous direction is a false *healthy* (see
 * src/server/backup/health.ts), so every "we couldn't tell" path is asserted to
 * report unhealthy rather than assumed benign.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateBackupHealth,
  buildBackupHealthPingBody,
  parseBackupListPage,
  parseBackupInfo,
  type BackupHealthSnapshot,
} from "../../src/server/backup/health";

const HOUR = 60 * 60 * 1000;
const MAX_AGE = 36 * HOUR;
const NOW = new Date("2026-08-15T12:00:00Z");
const PREFIX = "lion-reader-pg/base/";

function snapshot(overrides: Partial<BackupHealthSnapshot> = {}): BackupHealthSnapshot {
  return {
    lastSuccessfulBackupAt: new Date(NOW.getTime() - 2 * HOUR),
    lastSuccessfulBackupId: "20260815T100000",
    scannedCount: 1,
    failedCount: 0,
    backupInProgress: false,
    oldestScannedId: "20260815T100000",
    catalogSize: 12,
    ...overrides,
  };
}

function listXml(prefixes: string[], extra = ""): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>backups</Name><Prefix>${PREFIX}</Prefix><Delimiter>/</Delimiter>
  ${prefixes.map((p) => `<CommonPrefixes><Prefix>${p}</Prefix></CommonPrefixes>`).join("\n  ")}
  ${extra || "<IsTruncated>false</IsTruncated>"}
</ListBucketResult>`;
}

describe("parseBackupListPage", () => {
  it("extracts backup IDs from multiple CommonPrefixes", () => {
    const xml = listXml([`${PREFIX}20260801T013354/`, `${PREFIX}20260815T222200/`]);
    expect(parseBackupListPage(xml, PREFIX).ids).toEqual(["20260801T013354", "20260815T222200"]);
  });

  it("handles a single CommonPrefixes element, which the XML parser leaves unwrapped", () => {
    // The one-backup case would throw or silently yield nothing if the code
    // assumed an array — and a brand-new cluster has exactly one backup.
    const xml = listXml([`${PREFIX}20260801T013354/`]);
    expect(parseBackupListPage(xml, PREFIX).ids).toEqual(["20260801T013354"]);
  });

  it("returns no IDs for an empty catalog", () => {
    const xml = listXml([]);
    expect(parseBackupListPage(xml, PREFIX)).toEqual({ ids: [], nextContinuationToken: null });
  });

  it("returns the continuation token only when the listing is truncated", () => {
    const truncated = listXml(
      [`${PREFIX}20260801T013354/`],
      "<IsTruncated>true</IsTruncated><NextContinuationToken>abc123</NextContinuationToken>"
    );
    expect(parseBackupListPage(truncated, PREFIX).nextContinuationToken).toBe("abc123");

    const complete = listXml(
      [`${PREFIX}20260801T013354/`],
      "<IsTruncated>false</IsTruncated><NextContinuationToken>abc123</NextContinuationToken>"
    );
    expect(parseBackupListPage(complete, PREFIX).nextContinuationToken).toBeNull();
  });

  it("keeps an all-digit continuation token exact", () => {
    // Parsed as a number this would lose precision past 2^53 and the next page
    // request would 400.
    const token = "1234567890123456789012";
    const xml = listXml(
      [`${PREFIX}20260801T013354/`],
      `<IsTruncated>true</IsTruncated><NextContinuationToken>${token}</NextContinuationToken>`
    );
    expect(parseBackupListPage(xml, PREFIX).nextContinuationToken).toBe(token);
  });

  it("ignores entries outside the requested prefix", () => {
    const xml = listXml([`${PREFIX}20260801T013354/`, "some-other-server/base/20260801T013354/"]);
    expect(parseBackupListPage(xml, PREFIX).ids).toEqual(["20260801T013354"]);
  });

  it("returns no IDs for a response that isn't a listing", () => {
    const err = `<?xml version="1.0"?><Error><Code>AccessDenied</Code></Error>`;
    expect(parseBackupListPage(err, PREFIX)).toEqual({ ids: [], nextContinuationToken: null });
  });
});

describe("parseBackupInfo", () => {
  it("reads a completed backup's status and end time", () => {
    const info = parseBackupInfo(
      ["backup_label=None", "end_time=2026-08-01 01:43:04.123456+00:00", "status=DONE"].join("\n")
    );
    expect(info.status).toBe("DONE");
    expect(info.endTime?.toISOString()).toBe("2026-08-01T01:43:04.123Z");
  });

  it("handles a non-UTC offset", () => {
    const info = parseBackupInfo("end_time=2026-08-01 03:43:04.000000+02:00\nstatus=DONE");
    expect(info.endTime?.toISOString()).toBe("2026-08-01T01:43:04.000Z");
  });

  it("distinguishes in-progress from failed", () => {
    expect(parseBackupInfo("status=STARTED\nend_time=None").status).toBe("STARTED");
    expect(parseBackupInfo("status=FAILED\nerror=failure uploading data").status).toBe("FAILED");
  });

  it("reports an unrecognized or missing status as UNKNOWN", () => {
    expect(parseBackupInfo("status=WAITING_FOR_WALS").status).toBe("UNKNOWN");
    expect(parseBackupInfo("backup_label=None").status).toBe("UNKNOWN");
  });

  it("returns a null end time when it is absent, None, or unparseable", () => {
    expect(parseBackupInfo("status=DONE").endTime).toBeNull();
    expect(parseBackupInfo("status=DONE\nend_time=None").endTime).toBeNull();
    expect(parseBackupInfo("status=DONE\nend_time=not a date").endTime).toBeNull();
  });

  it("is not confused by a status-like substring in another field", () => {
    const info = parseBackupInfo("error=backup status=DONE was not reached\nstatus=FAILED");
    expect(info.status).toBe("FAILED");
  });
});

describe("evaluateBackupHealth", () => {
  it("is healthy when a backup completed within the threshold", () => {
    const result = evaluateBackupHealth(snapshot(), NOW, MAX_AGE);
    expect(result.status).toBe("healthy");
    expect(result.lastSuccessAgeMs).toBe(2 * HOUR);
  });

  it("is healthy just inside the threshold", () => {
    const s = snapshot({ lastSuccessfulBackupAt: new Date(NOW.getTime() - MAX_AGE + 1000) });
    expect(evaluateBackupHealth(s, NOW, MAX_AGE).status).toBe("healthy");
  });

  it("is unhealthy just outside the threshold", () => {
    const s = snapshot({ lastSuccessfulBackupAt: new Date(NOW.getTime() - MAX_AGE - 1000) });
    expect(evaluateBackupHealth(s, NOW, MAX_AGE).status).toBe("unhealthy");
  });

  it("is unhealthy when the newest success has aged out, even though one exists", () => {
    const s = snapshot({
      lastSuccessfulBackupAt: new Date("2026-08-01T01:43:04Z"),
      lastSuccessfulBackupId: "20260801T013354",
      failedCount: 115,
      scannedCount: 116,
      catalogSize: 118,
    });
    const result = evaluateBackupHealth(s, NOW, MAX_AGE);
    expect(result.status).toBe("unhealthy");
    expect(result.reason).toContain("346h old");
  });

  it("is unhealthy when no success was found in the scanned window", () => {
    const s = snapshot({
      lastSuccessfulBackupAt: null,
      lastSuccessfulBackupId: null,
      scannedCount: 80,
      failedCount: 80,
      oldestScannedId: "20260805T031500",
    });
    const result = evaluateBackupHealth(s, NOW, MAX_AGE);
    expect(result.status).toBe("unhealthy");
    expect(result.reason).toContain("20260805T031500");
  });

  it("is unhealthy when backups have never run", () => {
    const s = snapshot({
      lastSuccessfulBackupAt: null,
      lastSuccessfulBackupId: null,
      scannedCount: 0,
      failedCount: 0,
      oldestScannedId: null,
      catalogSize: 0,
    });
    expect(evaluateBackupHealth(s, NOW, MAX_AGE)).toMatchObject({
      status: "unhealthy",
      lastSuccessAgeMs: null,
    });
  });

  it("fails closed when a successful backup has no completion time", () => {
    // Assuming "current" would defeat the whole check.
    const s = snapshot({ lastSuccessfulBackupAt: null, lastSuccessfulBackupId: "20260815T100000" });
    const result = evaluateBackupHealth(s, NOW, MAX_AGE);
    expect(result.status).toBe("unhealthy");
    expect(result.reason).toContain("no recorded completion time");
  });

  it("stays healthy while a backup is in progress", () => {
    const s = snapshot({ backupInProgress: true });
    expect(evaluateBackupHealth(s, NOW, MAX_AGE).status).toBe("healthy");
  });
});

describe("buildBackupHealthPingBody", () => {
  it("explains a failure without needing the app, and says what to run", () => {
    const s = snapshot({
      lastSuccessfulBackupAt: new Date("2026-08-01T01:43:04Z"),
      lastSuccessfulBackupId: "20260801T013354",
      failedCount: 115,
      catalogSize: 118,
    });
    const body = buildBackupHealthPingBody(s, evaluateBackupHealth(s, NOW, MAX_AGE));
    expect(body).toContain("Status: unhealthy");
    expect(body).toContain("20260801T013354");
    expect(body).toContain("2026-08-01T01:43:04.000Z");
    expect(body).toContain("Failed backups newer than that: 115");
    expect(body).toContain("flexctl backup list");
  });

  it("omits the investigation hint when healthy", () => {
    const s = snapshot();
    const body = buildBackupHealthPingBody(s, evaluateBackupHealth(s, NOW, MAX_AGE));
    expect(body).toContain("Status: healthy");
    expect(body).not.toContain("flexctl backup list");
  });

  it("says how far it looked when no successful backup was found", () => {
    const s = snapshot({
      lastSuccessfulBackupAt: null,
      lastSuccessfulBackupId: null,
      scannedCount: 80,
    });
    const body = buildBackupHealthPingBody(s, evaluateBackupHealth(s, NOW, MAX_AGE));
    expect(body).toContain("Newest successful backup: none found in the newest 80");
  });

  it("mentions an in-progress backup so a fresh failure isn't misread", () => {
    const s = snapshot({ backupInProgress: true });
    const body = buildBackupHealthPingBody(s, evaluateBackupHealth(s, NOW, MAX_AGE));
    expect(body).toContain("A backup is currently in progress.");
  });
});
