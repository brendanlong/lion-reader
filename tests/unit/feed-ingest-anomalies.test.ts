/**
 * Unit tests for feed ingest anomaly detection (issue #1500): a feed serving
 * more entries than we keep, and a feed we already poll introducing articles
 * published long before the previous poll.
 */

import { describe, it, expect } from "vitest";
import {
  detectFeedIngestAnomalies,
  BACKFILL_AGE_THRESHOLD_MS,
} from "../../src/server/feed/ingest-anomalies";
import type { ProcessEntriesResult, ProcessedEntry } from "../../src/server/feed/entry-processor";
import type { ParsedFeed } from "../../src/server/feed/types";

const PREVIOUS_FETCH = new Date("2026-08-01T00:00:00Z");

function parsedFeed(itemCount: number, totalItemCount?: number): ParsedFeed {
  return {
    title: "Test Feed",
    items: Array.from({ length: itemCount }, (_, i) => ({ guid: `guid-${i}` })),
    totalItemCount,
  };
}

function newEntry(guid: string, publishedAt: Date | null): ProcessedEntry {
  return {
    id: `id-${guid}`,
    guid,
    isNew: true,
    isUpdated: false,
    updatedAt: PREVIOUS_FETCH,
    newEntryData: {
      url: null,
      title: guid,
      author: null,
      summary: null,
      publishedAt,
      fetchedAt: PREVIOUS_FETCH,
      siteName: null,
    },
  };
}

function existingEntry(guid: string): ProcessedEntry {
  return { id: `id-${guid}`, guid, isNew: false, isUpdated: false };
}

function processed(entries: ProcessedEntry[]): ProcessEntriesResult {
  const newCount = entries.filter((e) => e.isNew).length;
  return {
    newCount,
    updatedCount: entries.filter((e) => e.isUpdated).length,
    unchangedCount: entries.filter((e) => !e.isNew && !e.isUpdated).length,
    disappearedCount: 0,
    hasChanges: newCount > 0,
    entries,
  };
}

/** A date `days` before the previous fetch. */
function daysBeforePreviousFetch(days: number): Date {
  return new Date(PREVIOUS_FETCH.getTime() - days * 24 * 60 * 60 * 1000);
}

describe("detectFeedIngestAnomalies", () => {
  describe("truncation", () => {
    it("reports nothing when the feed fit within the limit", () => {
      const anomalies = detectFeedIngestAnomalies(
        parsedFeed(10, 10),
        processed([]),
        PREVIOUS_FETCH
      );

      expect(anomalies.droppedItemCount).toBe(0);
    });

    it("counts the entries the limit discarded", () => {
      const anomalies = detectFeedIngestAnomalies(
        parsedFeed(100, 628),
        processed([]),
        PREVIOUS_FETCH
      );

      expect(anomalies.droppedItemCount).toBe(528);
    });

    it("reports nothing for a synthetic feed that carries no total", () => {
      const anomalies = detectFeedIngestAnomalies(parsedFeed(5), processed([]), PREVIOUS_FETCH);

      expect(anomalies.droppedItemCount).toBe(0);
    });
  });

  describe("backfill", () => {
    it("reports nothing when every new entry is recent", () => {
      const anomalies = detectFeedIngestAnomalies(
        parsedFeed(2, 2),
        processed([newEntry("a", new Date("2026-08-02T00:00:00Z"))]),
        PREVIOUS_FETCH
      );

      expect(anomalies.backfilledCount).toBe(0);
      expect(anomalies.oldestBackfilledPublishedAt).toBeNull();
      expect(anomalies.newestBackfilledPublishedAt).toBeNull();
    });

    it("counts new entries published well before the previous fetch", () => {
      const anomalies = detectFeedIngestAnomalies(
        parsedFeed(3, 3),
        processed([
          newEntry("old", new Date("2022-03-14T00:00:00Z")),
          newEntry("older", new Date("2022-03-01T00:00:00Z")),
          newEntry("recent", new Date("2026-08-02T00:00:00Z")),
        ]),
        PREVIOUS_FETCH
      );

      expect(anomalies.backfilledCount).toBe(2);
      expect(anomalies.oldestBackfilledPublishedAt).toEqual(new Date("2022-03-01T00:00:00Z"));
      expect(anomalies.newestBackfilledPublishedAt).toEqual(new Date("2022-03-14T00:00:00Z"));
    });

    it("ignores entries we already had", () => {
      const anomalies = detectFeedIngestAnomalies(
        parsedFeed(1, 1),
        processed([existingEntry("known")]),
        PREVIOUS_FETCH
      );

      expect(anomalies.backfilledCount).toBe(0);
    });

    it("ignores new entries with no publication date", () => {
      const anomalies = detectFeedIngestAnomalies(
        parsedFeed(1, 1),
        processed([newEntry("undated", null)]),
        PREVIOUS_FETCH
      );

      expect(anomalies.backfilledCount).toBe(0);
    });

    // Publishers backdate a little all the time; only an entry older than the
    // grace window counts.
    it("allows ordinary publishing lag inside the grace window", () => {
      const justInside = new Date(PREVIOUS_FETCH.getTime() - BACKFILL_AGE_THRESHOLD_MS + 1000);
      const justOutside = new Date(PREVIOUS_FETCH.getTime() - BACKFILL_AGE_THRESHOLD_MS - 1000);

      expect(
        detectFeedIngestAnomalies(
          parsedFeed(1, 1),
          processed([newEntry("lagging", justInside)]),
          PREVIOUS_FETCH
        ).backfilledCount
      ).toBe(0);

      expect(
        detectFeedIngestAnomalies(
          parsedFeed(1, 1),
          processed([newEntry("backfilled", justOutside)]),
          PREVIOUS_FETCH
        ).backfilledCount
      ).toBe(1);
    });

    // A feed's first fetch legitimately brings in its whole current window,
    // however old that is.
    it("reports nothing on the first fetch of a feed", () => {
      const anomalies = detectFeedIngestAnomalies(
        parsedFeed(2, 2),
        processed([
          newEntry("ancient", daysBeforePreviousFetch(1500)),
          newEntry("old", daysBeforePreviousFetch(300)),
        ]),
        null
      );

      expect(anomalies.backfilledCount).toBe(0);
    });
  });
});
