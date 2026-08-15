/**
 * Unit tests for base-backup health evaluation.
 *
 * These encode the alerting rule "a base backup must have completed in the last
 * N hours". The cases are drawn from the real 2026-08 outage, where backups
 * failed for 14 days while every other signal (WAL archiving, app health,
 * Postgres itself) stayed green — so the "many failures on top of a stale
 * success" case is the one that matters most.
 *
 * The object-storage read is covered separately; only the pure rule lives here.
 */

import { describe, it, expect } from "vitest";
import {
  evaluateBackupHealth,
  buildBackupHealthPingBody,
  type BackupHealthSnapshot,
} from "../../src/server/backup/health";

const HOUR = 60 * 60 * 1000;
const MAX_AGE = 36 * HOUR;
const NOW = new Date("2026-08-15T12:00:00Z");

function snapshot(overrides: Partial<BackupHealthSnapshot> = {}): BackupHealthSnapshot {
  return {
    lastSuccessfulBackupAt: new Date(NOW.getTime() - 2 * HOUR),
    lastSuccessfulBackupId: "20260815T100000",
    scannedCount: 1,
    failedCount: 0,
    oldestScannedId: "20260815T100000",
    catalogSize: 12,
    ...overrides,
  };
}

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
    // The 2026-08 outage: a good backup from 2026-08-01, then 115 failures.
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
      scannedCount: 30,
      failedCount: 30,
      oldestScannedId: "20260812T031500",
    });
    const result = evaluateBackupHealth(s, NOW, MAX_AGE);
    expect(result.status).toBe("unhealthy");
    expect(result.reason).toContain("20260812T031500");
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
    // Storage didn't return Last-Modified. Assuming "current" would defeat the
    // whole check, so an unknown age must not read as healthy.
    const s = snapshot({ lastSuccessfulBackupAt: null, lastSuccessfulBackupId: "20260815T100000" });
    expect(evaluateBackupHealth(s, NOW, MAX_AGE).status).toBe("unhealthy");
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

  it("reports a missing backup as 'none found' rather than an empty field", () => {
    const s = snapshot({ lastSuccessfulBackupAt: null, lastSuccessfulBackupId: null });
    const body = buildBackupHealthPingBody(s, evaluateBackupHealth(s, NOW, MAX_AGE));
    expect(body).toContain("Newest successful backup: none found");
  });
});
