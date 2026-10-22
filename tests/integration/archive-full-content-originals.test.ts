/**
 * Integration tests for scripts/archive-full-content-originals.ts (#2115).
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import { gunzipSync } from "node:zlib";
import { sql } from "drizzle-orm";
import { db } from "../../src/server/db";
import { entries, feeds } from "../../src/server/db/schema";
import { storageConfig } from "../../src/server/config/env";
import { FULL_CONTENT_EXTRACTION_FAILED } from "../../src/server/services/full-content";
import { fullContentArchiveKey } from "../../src/server/services/full-content-archive";
import { archiveFullContentOriginals } from "../../scripts/archive-full-content-originals";
import { useFakeS3, type FakeS3 } from "../utils/fake-s3";
import { createTestEntry, createTestFeed } from "./helpers";

const BUCKET = "test-archive";
const fetchedAt = new Date("2026-01-01T00:00:00Z");

let s3: FakeS3;

interface Row extends Record<string, unknown> {
  original: string | null;
  error: string | null;
  updated_at: Date;
}

async function readRow(entryId: string): Promise<Row> {
  const result = await db.execute<Row>(
    sql`SELECT full_content_original AS original, full_content_error AS error, updated_at
        FROM entries WHERE id = ${entryId}`
  );
  return { ...result.rows[0], updated_at: new Date(result.rows[0].updated_at) };
}

/** An entry as fetches stored it before #2115, with the page on the row. */
async function createFetchedEntry(
  feedId: string,
  page: string | null,
  fields: { fullContentCleaned?: string | null; fullContentError?: string | null } = {}
): Promise<string> {
  const entryId = await createTestEntry(feedId, {
    fetchedAt,
    fullContentFetchedAt: fetchedAt,
    fullContentHash: "hash",
    fullContentCleaned: "<p>Article</p>",
    ...fields,
  });
  await db.execute(sql`UPDATE entries SET full_content_original = ${page} WHERE id = ${entryId}`);
  return entryId;
}

function archived(entryId: string): string | undefined {
  const object = s3.objects.get(`${BUCKET}/${fullContentArchiveKey(entryId)}`);
  return object && gunzipSync(object).toString("utf8");
}

async function cleanup(): Promise<void> {
  await db.delete(entries);
  await db.delete(feeds);
}

beforeEach(async () => {
  await cleanup();
  s3 = await useFakeS3(BUCKET);
});

afterEach(async () => {
  await s3.close();
});

afterAll(cleanup);

describe("archiveFullContentOriginals", () => {
  it("archives every page, clears the column, and fails fetches that showed the whole page", async () => {
    const feedId = await createTestFeed();
    const extracted = await createFetchedEntry(feedId, "<html>extracted</html>");
    const wholePage = await createFetchedEntry(feedId, "<html>whole page</html>", {
      fullContentCleaned: null,
    });
    const alreadyFailed = await createFetchedEntry(feedId, "<html>failed</html>", {
      fullContentCleaned: null,
      fullContentError: "HTTP 500: Internal Server Error",
    });
    const noPage = await createFetchedEntry(feedId, null);

    // Smaller than the row count, so the walk crosses batches.
    const result = await archiveFullContentOriginals(db, { batchSize: 2, pauseMs: 0 });

    expect(result).toEqual({ archived: 3, failedUploads: 0 });
    expect(archived(extracted)).toBe("<html>extracted</html>");
    expect(archived(wholePage)).toBe("<html>whole page</html>");
    expect(archived(alreadyFailed)).toBe("<html>failed</html>");
    expect(archived(noPage)).toBeUndefined();

    expect(await readRow(extracted)).toEqual({
      original: null,
      error: null,
      updated_at: fetchedAt,
    });
    const whole = await readRow(wholePage);
    expect(whole.original).toBeNull();
    expect(whole.error).toBe(FULL_CONTENT_EXTRACTION_FAILED);
    expect(whole.updated_at.getTime()).toBeGreaterThan(fetchedAt.getTime());
    expect(await readRow(alreadyFailed)).toEqual({
      original: null,
      error: "HTTP 500: Internal Server Error",
      updated_at: fetchedAt,
    });
  });

  it("keeps a page on the row when its upload fails", async () => {
    const entryId = await createFetchedEntry(await createTestFeed(), "<html>page</html>");
    s3.failPutsWith = 503;

    const result = await archiveFullContentOriginals(db, { pauseMs: 0 });

    expect(result).toEqual({ archived: 0, failedUploads: 1 });
    expect((await readRow(entryId)).original).toBe("<html>page</html>");
  });

  it("refuses to run without the archive bucket", async () => {
    const entryId = await createFetchedEntry(await createTestFeed(), "<html>page</html>");
    storageConfig.archiveBucket = undefined;

    await expect(archiveFullContentOriginals(db, { pauseMs: 0 })).rejects.toThrow();

    expect((await readRow(entryId)).original).toBe("<html>page</html>");
  });
});
