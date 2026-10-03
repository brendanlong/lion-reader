/**
 * Unit tests for classifyBackupPollEntries - the pure grace-period split that
 * decides whether a backup-poll-discovered new entry is a confirmed push miss
 * or an ambiguous near-miss.
 */

import { describe, it, expect } from "vitest";
import {
  classifyBackupPollEntries,
  WEBSUB_PUSH_GRACE_PERIOD_MS,
} from "../../src/server/feed/websub-hub-stats";

const NOW = new Date("2026-07-06T12:00:00.000Z");

/** A Date `ms` before NOW. */
function ago(ms: number): Date {
  return new Date(NOW.getTime() - ms);
}

describe("classifyBackupPollEntries", () => {
  it("counts an entry published well before the grace window as a confirmed miss", () => {
    const result = classifyBackupPollEntries([ago(4 * WEBSUB_PUSH_GRACE_PERIOD_MS)], NOW);
    expect(result).toEqual({ backupMisses: 1, nearMisses: 0 });
  });

  it("counts an entry published within the grace window as a near-miss", () => {
    const result = classifyBackupPollEntries([ago(WEBSUB_PUSH_GRACE_PERIOD_MS / 2)], NOW);
    expect(result).toEqual({ backupMisses: 0, nearMisses: 1 });
  });

  it("treats an entry exactly at the grace boundary as a confirmed miss", () => {
    const result = classifyBackupPollEntries([ago(WEBSUB_PUSH_GRACE_PERIOD_MS)], NOW);
    expect(result).toEqual({ backupMisses: 1, nearMisses: 0 });
  });

  it("counts an entry one ms inside the grace boundary as a near-miss", () => {
    const result = classifyBackupPollEntries([ago(WEBSUB_PUSH_GRACE_PERIOD_MS - 1)], NOW);
    expect(result).toEqual({ backupMisses: 0, nearMisses: 1 });
  });

  it("treats an unknown publish date as a near-miss (can't prove it's old)", () => {
    expect(classifyBackupPollEntries([null], NOW)).toEqual({ backupMisses: 0, nearMisses: 1 });
    expect(classifyBackupPollEntries([undefined], NOW)).toEqual({ backupMisses: 0, nearMisses: 1 });
  });

  it("treats a future publish date as a near-miss", () => {
    const future = new Date(NOW.getTime() + 60 * 1000);
    expect(classifyBackupPollEntries([future], NOW)).toEqual({ backupMisses: 0, nearMisses: 1 });
  });

  it("tallies a mixed batch", () => {
    const result = classifyBackupPollEntries(
      [
        ago(2 * WEBSUB_PUSH_GRACE_PERIOD_MS),
        ago(WEBSUB_PUSH_GRACE_PERIOD_MS / 2),
        null,
        ago(10 * WEBSUB_PUSH_GRACE_PERIOD_MS),
      ],
      NOW
    );
    expect(result).toEqual({ backupMisses: 2, nearMisses: 2 });
  });

  it("returns zeros for an empty batch", () => {
    expect(classifyBackupPollEntries([], NOW)).toEqual({ backupMisses: 0, nearMisses: 0 });
  });

  it("honors a custom grace period", () => {
    // A miss under the default grace, a near-miss under a longer one.
    expect(classifyBackupPollEntries([ago(2 * WEBSUB_PUSH_GRACE_PERIOD_MS)], NOW)).toEqual({
      backupMisses: 1,
      nearMisses: 0,
    });
    expect(
      classifyBackupPollEntries(
        [ago(2 * WEBSUB_PUSH_GRACE_PERIOD_MS)],
        NOW,
        4 * WEBSUB_PUSH_GRACE_PERIOD_MS
      )
    ).toEqual({
      backupMisses: 0,
      nearMisses: 1,
    });
  });
});
